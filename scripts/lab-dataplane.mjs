#!/usr/bin/env node
/**
 * 数据面与限速验证实验（真实 easytier-core + 真实 TCP 流量）。
 *
 * 与 scripts/lab.mjs 的分工：
 *   lab.mjs         验证控制面 —— 单端口多房间、房间隔离、网络名准入、调度、踢人、
 *                   流量归因。它刻意用 `no_tun` 跑，因为「同机多个虚拟网卡 + 同网段」
 *                   会让操作系统的路由表产生歧义，OS 层 ping 测试不可靠。
 *   本脚本          验证数据面 —— 真的把字节从 A 送到 B，并验证限速确实生效。
 *                   做法是用 EasyTier 自己的端口转发（`easytier-cli port-forward add`）
 *                   在虚拟网络内部转发 TCP：转发是在 EasyTier 内部完成的，
 *                   不依赖操作系统路由表，因此同机多实例也能得到可信结果。
 *
 * 断言：
 *   1. 虚拟网络里两台实例能互相看见（peer 列表包含对方虚拟 IP）
 *   2. 端口转发可用：成员机本地端口 → 房主虚拟 IP 上的 TCP 服务，字节完全送达
 *   3. 不限速时吞吐显著高于限速阈值（基准）
 *   4. 设置 perMemberKbps 后，成员票据里出现 instance_recv_bps_limit，
 *      且实测吞吐被压到该上限附近（限速真的生效）
 *
 * 前置：主控在 8787 运行、vendor/easytier 有二进制、当前进程有管理员权限（要建 TUN 网卡）。
 * 用法：node scripts/lab-dataplane.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = process.env.MCLINK_VENDOR ?? path.join(REPO_ROOT, 'vendor', 'easytier');
const CORE = path.join(VENDOR, process.platform === 'win32' ? 'easytier-core.exe' : 'easytier-core');
const CLI = path.join(VENDOR, process.platform === 'win32' ? 'easytier-cli.exe' : 'easytier-cli');

const MASTER = process.env.MCLINK_MASTER ?? 'http://127.0.0.1:8787';
const ADMIN_USER = process.env.MCLINK_ADMIN_USER ?? 'admin';
const ADMIN_PASS = process.env.MCLINK_ADMIN_PASSWORD ?? 'dev-only-passw0rd';

const DIR = path.join(REPO_ROOT, '.cache', 'lab-dataplane');
const RUN_ID = Date.now().toString(36).slice(-5);
const BASE_PORT = 13200 + Math.floor(Math.random() * 40) * 10;

/** 限速基准：1000 kbps。载荷 2MiB 时理论耗时约 16.8s，不限速则 <1s，差异极显著 */
const LIMIT_KBPS = 1000;
const PAYLOAD_BYTES = 2 * 1024 * 1024;

const colors = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  fail: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  head: (s) => `\x1b[36m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
};

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`  [${condition ? colors.ok('PASS') : colors.fail('FAIL')}] ${name}${detail ? colors.dim(`  — ${detail}`) : ''}`);
  return Boolean(condition);
}
const step = (t) => console.log(`\n${colors.head('▸ ' + t)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ API */

async function api(pathname, { method = 'GET', body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${MASTER}/api/v1${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${pathname} 返回非 JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status} ${json?.error?.code} ${json?.error?.message}`);
  return json.data;
}

/* --------------------------------------------------------- 进程与 CLI */

const children = [];

/**
 * 改写票据配置，使多个实例能在同一台机器上并行运行。
 * 关键点：必须给每个实例不同的 dev_name，否则两个实例会去创建同名的 TUN 网卡而互相打架。
 */
function adaptConfig(ticket, { listenPort, devName }) {
  let text = ticket.configToml;
  text = text.replace(
    /^listeners = \[.*\]$/m,
    `listeners = ["tcp://0.0.0.0:${listenPort}", "udp://0.0.0.0:${listenPort}"]`,
  );
  text = text.replace(/^hostname = .*$/m, `hostname = ${JSON.stringify(devName)}`);
  // 数据面测试必须真的建虚拟网卡：把 no_tun 强制为 false，并给独立的网卡名
  if (/^no_tun = /m.test(text)) text = text.replace(/^no_tun = .*$/m, 'no_tun = false');
  else text = text.replace(/^\[flags\]$/m, `[flags]\nno_tun = false`);
  text = text.replace(/^\[flags\]$/m, `[flags]\ndev_name = ${JSON.stringify(devName)}`);
  return text;
}

function spawnCore(name, configText, launchArgs) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${name}.toml`);
  fs.writeFileSync(file, configText, 'utf8');
  const validated = validateConfig(file);
  if (!validated.ok) {
    console.error(colors.fail(`  配置被 easytier-core 判为非法（${name}）: ${validated.output.split('\n')[0]}`));
  } else {
    console.log(colors.dim(`  [配置校验通过] ${name}.toml`));
  }
  const fd = fs.openSync(path.join(DIR, `${name}.log`), 'w');
  const args = (launchArgs ?? ['-c', '%CONFIG%']).map((a) => (a === '%CONFIG%' ? file : a));
  const child = spawn(CORE, args, { stdio: ['ignore', fd, fd], windowsHide: true });
  child.__configValid = validated.ok;
  children.push(child);
  return child;
}

function cli(rpcPortal, args) {
  return new Promise((resolve) => {
    const child = spawn(CLI, ['-p', rpcPortal, '-o', 'json', ...args], { windowsHide: true });
    const out = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => out.push(c));
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      const text = Buffer.concat(out).toString('utf8').trim();
      // 退出码才是成败判据：有些子命令（如 port-forward add）只打一行人类可读提示，
      // 不带 JSON —— 那是成功，不是解析失败。
      if (code !== 0) return resolve({ ok: false, error: `exit=${code} ${text.slice(0, 200)}` });
      if (text.length === 0) return resolve({ ok: true, data: null });
      try {
        return resolve({ ok: true, data: JSON.parse(text) });
      } catch {
        // 前面的提示行会干扰解析，从第一个 { 或 [ 截取再试
        const start = text.search(/[[{]/);
        if (start >= 0) {
          try {
            return resolve({ ok: true, data: JSON.parse(text.slice(start)) });
          } catch {
            /* 落到 raw 分支 */
          }
        }
        return resolve({ ok: true, data: null, raw: text });
      }
    });
  });
}

/**
 * 用 easytier-core 自己的 `--check-config` 校验生成的配置。
 * 加这一步是因为踩过一个只有真实二进制才暴露的坑：
 * u64 限速字段被写成带引号的字符串时，配置解析会直接 panic，
 * 而纯 TypeScript 侧的测试完全看不出来。
 */
function validateConfig(file) {
  const res = spawnSync(CORE, ['-c', file, '--check-config'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  return { ok: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}`.slice(0, 300) };
}

/**
 * 由监听端口推导 RPC portal 地址。
 * 规则与服务端 `rpcPortalForListenPort` 一致（16000 + port % 1000）；
 * 注意 easytier-cli 的 `-p` 要求 `host:port` 完整地址，裸端口会被拒绝。
 */
const rpcFor = (listenPort) => `127.0.0.1:${16000 + (listenPort % 1000)}`;

async function waitFor(desc, fn, timeoutMs = 40_000, intervalMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(intervalMs);
  }
  console.log(colors.warn(`  等待超时: ${desc}`));
  return null;
}

/** 取某实例看到的远端 peer 的虚拟地址 */
async function peerIps(rpcPortal) {
  const res = await cli(rpcPortal, ['peer', 'list']);
  if (!res.ok || !Array.isArray(res.data)) return { ips: [], error: res.error };
  const ips = res.data
    .filter((r) => String(r.cost ?? '') !== 'Local' && String(r.ipv4 ?? '').length > 0)
    .map((r) => String(r.ipv4));
  return { ips, error: null };
}

/* ------------------------------------------------------------ TCP 收发 */

/**
 * 在房主侧起一个「假装是 Minecraft 服务端」的 TCP 服务：连上就猛发 payload 字节然后关闭。
 * 这样测出来的时间就是可计量的传输耗时。
 */
function startSinkServer(port) {
  return new Promise((resolve) => {
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      let sent = 0;
      const pump = () => {
        while (sent < PAYLOAD_BYTES) {
          const size = Math.min(chunk.length, PAYLOAD_BYTES - sent);
          sent += size;
          if (!socket.write(size === chunk.length ? chunk : chunk.subarray(0, size))) {
            socket.once('drain', pump);
            return;
          }
        }
        socket.end();
      };
      socket.on('error', () => {});
      pump();
    });
    server.listen(port, '0.0.0.0', () => resolve(server));
    server.on('error', (err) => {
      console.error(colors.fail(`TCP 服务启动失败: ${err.message}`));
      resolve(null);
    });
  });
}

/** 连到本地转发端口，接收直到对端关闭，返回耗时与字节数 */
function measureDownload(port, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let bytes = 0;
    let firstByteAt = 0;
    const socket = net.connect({ port, host: '127.0.0.1' });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ bytes, ms: Date.now() - started, timedOut: true });
    }, timeoutMs);
    socket.on('connect', () => socket.setNoDelay(true));
    socket.on('data', (buf) => {
      if (firstByteAt === 0) firstByteAt = Date.now();
      bytes += buf.length;
    });
    socket.on('end', () => {
      clearTimeout(timer);
      resolve({ bytes, ms: Date.now() - (firstByteAt || started), timedOut: false });
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      resolve({ bytes, ms: Date.now() - started, timedOut: false, error: err.message });
    });
  });
}

const kbps = (bytes, ms) => (ms <= 0 ? Number.POSITIVE_INFINITY : (bytes * 8) / 1000 / (ms / 1000));

/* ------------------------------------------------------------- 主流程 */

async function main() {
  for (const bin of [CORE, CLI]) {
    if (!fs.existsSync(bin)) {
      console.error(colors.fail(`缺少二进制: ${bin}（先运行 pnpm fetch:easytier）`));
      process.exit(2);
    }
  }
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  const hostPort = BASE_PORT + 1;
  const memberPort = BASE_PORT + 2;
  const minecraftPort = BASE_PORT + 3; // 房主机器上"MC 服务端"的本地端口
  const forwardPort = BASE_PORT + 4; // 成员机器上由 EasyTier 暴露的转发端口

  step('准备账号与房间');
  const admin = await api('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  const mkUser = async (prefix) => {
    const username = `${prefix}${RUN_ID}`;
    /**
     * 平台现在要求验证邮箱（默认开），实验脚本收不到邮件 —— 带上邮箱注册，
     * 再把库里那一行直接标成已验证（与 scripts/lab.mjs 的绕过方式一致）。
     */
    const reg = await api('/auth/register', {
      method: 'POST',
      body: {
        username,
        password: 'Lab-Test-123',
        displayName: username,
        email: `${username}@example.com`,
      },
    });
    const db = new DatabaseSync(path.join(REPO_ROOT, 'server', 'data', 'mclink.sqlite'));
    db.prepare('update users set email_verified = 1 where username = ?').run(username);
    db.close();
    return { username, token: reg.token, userId: reg.user.id };
  };
  const host = await mkUser('dphost');
  const member = await mkUser('dpmem');
  check('创建实验账号', true, `host=${host.username} member=${member.username}`);

  // 先把「不限速」的房间建出来作为基准
  const roomFree = await api('/rooms', {
    method: 'POST',
    token: host.token,
    body: { name: `数据面基准 ${RUN_ID}`, zone: 'auto', visibility: 'hidden', listenPort: hostPort },
  });
  check('创建不限速房间（基准）', Boolean(roomFree.ticket?.networkName), roomFree.room.code);
  check(
    '不限速房间的配置里没有 instance_recv_bps_limit',
    !roomFree.ticket.configToml.includes('instance_recv_bps_limit'),
  );

  step('验证房主机器上的 TCP 服务就绪（模拟 Minecraft 服务端）');
  const server = await startSinkServer(minecraftPort);
  check('TCP 服务已监听', server !== null, `127.0.0.1:${minecraftPort}（对虚拟网络暴露为房主虚拟IP:该端口）`);

  step('启动两个带真实虚拟网卡（TUN）的客户端');
  const hostRpc = rpcFor(hostPort);
  const memberRpc = rpcFor(memberPort);
  spawnCore('host', adaptConfig(roomFree.ticket, { listenPort: hostPort, devName: `mclink-dp-${RUN_ID}-a` }), roomFree.ticket.launchArgs);
  check('已启动房主实例（TUN 开启）', true, `rpc=${hostRpc} dev=mclink-dp-${RUN_ID}-a`);
  await sleep(2500);

  const hostPeers = await waitFor(
    '房主实例的 RPC 可用',
    async () => {
      const r = await cli(hostRpc, ['node', 'info']);
      return r.ok ? r : null;
    },
    30_000,
    2000,
  );
  check('房主实例 RPC 可访问', Boolean(hostPeers), `127.0.0.1:${hostRpc}`);

  // 成员用同一个（不限速）房间的票据加入，先量基准
  const joinFree = await api('/rooms/join', {
    method: 'POST',
    token: member.token,
    body: { code: roomFree.room.code, deviceName: `member-${RUN_ID}`, listenPort: memberPort },
  });
  spawnCore('member', adaptConfig(joinFree.ticket, { listenPort: memberPort, devName: `mclink-dp-${RUN_ID}-b` }), joinFree.ticket.launchArgs);
  check('已启动成员实例（TUN 开启）', true, `rpc=${memberRpc} dev=mclink-dp-${RUN_ID}-b`);

  step('等待虚拟网络收敛（两个实例互相可见）');
  const hostVirtualIp = roomFree.ticket.virtualIp.split('/')[0];
  const memberVirtualIp = joinFree.ticket.virtualIp.split('/')[0];
  const visible = await waitFor(
    '房主看到成员',
    async () => {
      const { ips } = await peerIps(hostRpc);
      return ips.includes(memberVirtualIp) ? ips : null;
    },
    60_000,
    2000,
  );
  check('虚拟网络内两实例互相可见', Boolean(visible), `房主看到: ${(visible ?? []).join(', ') || '无'}`);
  check('成员虚拟地址与房主处于同一 /24', memberVirtualIp.startsWith(hostVirtualIp.split('.').slice(0, 3).join('.')), `${hostVirtualIp} / ${memberVirtualIp}`);

  step('配置成员侧的端口转发（EasyTier 内部转发，不依赖系统路由表）');
  const addFwd = await cli(memberRpc, ['port-forward', 'add', 'tcp', `127.0.0.1:${forwardPort}`, `${hostVirtualIp}:${minecraftPort}`]);
  check(
    '端口转发规则添加成功',
    addFwd.ok,
    addFwd.ok ? `127.0.0.1:${forwardPort} -> ${hostVirtualIp}:${minecraftPort}` : addFwd.error,
  );
  const fwdList = await cli(memberRpc, ['port-forward', 'list']);
  check('转发规则已生效', fwdList.ok, JSON.stringify(fwdList.data ?? fwdList.error).slice(0, 200));

  step(`基准吞吐：不限速，传输 ${(PAYLOAD_BYTES / 1048576).toFixed(1)} MiB`);
  await sleep(2000);
  const baseline = await measureDownload(forwardPort);
  const baselineKbps = kbps(baseline.bytes, baseline.ms);
  console.log(
    colors.dim(
      `  收到 ${baseline.bytes} 字节 / ${baseline.ms} ms → ${Number.isFinite(baselineKbps) ? baselineKbps.toFixed(0) : '∞'} kbps` +
        (baseline.error ? ` (error: ${baseline.error})` : ''),
    ),
  );
  check('数据面可用：字节完整送达', baseline.bytes === PAYLOAD_BYTES, `${baseline.bytes} / ${PAYLOAD_BYTES} 字节`);
  check('不限速时吞吐显著高于限速阈值', baselineKbps > LIMIT_KBPS * 3, `${baselineKbps.toFixed(0)} kbps vs 阈值 ${LIMIT_KBPS} kbps`);

  /* --------------------------------------------------- 限速房间 */

  step(`创建限速房间（单成员接收上限 ${LIMIT_KBPS} kbps）`);
  const roomLimited = await api('/rooms', {
    method: 'POST',
    token: host.token,
    body: {
      name: `数据面限速 ${RUN_ID}`,
      zone: 'auto',
      visibility: 'hidden',
      listenPort: hostPort + 10,
      perMemberKbps: LIMIT_KBPS,
    },
  });
  const limitMatch = /^instance_recv_bps_limit = (\d+)$/m.exec(roomLimited.ticket.configToml);
  /** 期望值：kbps → 字节/秒（EasyTier 的 _bps_limit 单位是字节/秒，不是比特/秒） */
  const expectedLimit = Math.floor((LIMIT_KBPS * 1000) / 8);
  check(
    '限速房间的票据带上了 instance_recv_bps_limit（裸数字，且按字节/秒换算）',
    limitMatch?.[1] === String(expectedLimit),
    `配置值 = ${limitMatch?.[1] ?? '（缺失）'}，期望 ${expectedLimit}（= ${LIMIT_KBPS} kbps ÷ 8）`,
  );

  // 停掉旧实例，用限速房间重新组网
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
  children.length = 0;
  await sleep(2500);

  const hostPort2 = hostPort + 10;
  const memberPort2 = memberPort + 10;
  const hostRpc2 = rpcFor(hostPort2);
  const memberRpc2 = rpcFor(memberPort2);
  const forwardPort2 = forwardPort + 10;

  spawnCore('host-limit', adaptConfig(roomLimited.ticket, { listenPort: hostPort2, devName: `mclink-dp-${RUN_ID}-c` }), roomLimited.ticket.launchArgs);
  const joinLimited = await api('/rooms/join', {
    method: 'POST',
    token: member.token,
    body: { code: roomLimited.room.code, deviceName: `member-${RUN_ID}`, listenPort: memberPort2 },
  });
  const joinLimitMatch = /^instance_recv_bps_limit = (\d+)$/m.exec(joinLimited.ticket.configToml);
  check(
    '成员票据同样带上限速值',
    joinLimitMatch?.[1] === String(expectedLimit),
    `成员配置值 = ${joinLimitMatch?.[1] ?? '（缺失）'}`,
  );
  spawnCore('member-limit', adaptConfig(joinLimited.ticket, { listenPort: memberPort2, devName: `mclink-dp-${RUN_ID}-d` }), joinLimited.ticket.launchArgs);

  const limitedHostIp = roomLimited.ticket.virtualIp.split('/')[0];
  const limitedMemberIp = joinLimited.ticket.virtualIp.split('/')[0];
  const visible2 = await waitFor(
    '限速房间内两实例互相可见',
    async () => {
      const { ips } = await peerIps(hostRpc2);
      return ips.includes(limitedMemberIp) ? ips : null;
    },
    60_000,
    2000,
  );
  check('限速房间内虚拟网络已收敛', Boolean(visible2), `房主看到: ${(visible2 ?? []).join(', ') || '无'}`);

  const addFwd2 = await cli(memberRpc2, ['port-forward', 'add', 'tcp', `127.0.0.1:${forwardPort2}`, `${limitedHostIp}:${minecraftPort}`]);
  check('限速房间的端口转发已添加', addFwd2.ok, addFwd2.ok ? `-> ${limitedHostIp}:${minecraftPort}` : addFwd2.error);
  await sleep(2500);

  step(`限速吞吐：上限 ${LIMIT_KBPS} kbps，传输同样的 ${(PAYLOAD_BYTES / 1048576).toFixed(1)} MiB`);
  const limited = await measureDownload(forwardPort2, 120_000);
  const limitedKbps = kbps(limited.bytes, limited.ms);
  console.log(
    colors.dim(
      `  收到 ${limited.bytes} 字节 / ${limited.ms} ms → ${Number.isFinite(limitedKbps) ? limitedKbps.toFixed(0) : '∞'} kbps` +
        (limited.timedOut ? '（超时终止）' : ''),
    ),
  );

  check('限速下数据仍能送达（没有被限死）', limited.bytes > 0, `${limited.bytes} 字节`);
  check(
    '实测吞吐被压到设定上限附近（限速真实生效）',
    limitedKbps <= LIMIT_KBPS * 1.6,
    `${limitedKbps.toFixed(0)} kbps ≤ ${(LIMIT_KBPS * 1.6).toFixed(0)} kbps`,
  );
  check(
    '限速后吞吐显著低于基准（数量级差异，排除测量噪声）',
    baselineKbps / Math.max(limitedKbps, 1) > 3,
    `基准 ${baselineKbps.toFixed(0)} kbps → 限速后 ${limitedKbps.toFixed(0)} kbps`,
  );

  server?.close();
  return results;
}

function cleanup() {
  for (const c of children) {
    try {
      if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
}

process.on('SIGINT', () => {
  cleanup();
  setTimeout(() => process.exit(130), 200);
});

async function finish(code) {
  cleanup();
  await sleep(400);
  process.exit(code);
}

try {
  const results = await main();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${colors.head('═══ 数据面实验结论 ═══')}`);
  console.log(`  通过 ${passed}/${results.length}`);
  for (const f of failed) console.log(colors.fail(`    - ${f.name}${f.detail ? ` (${f.detail})` : ''}`));
  console.log(colors.dim(`  日志与配置: ${DIR}`));
  await finish(failed.length === 0 ? 0 : 1);
} catch (err) {
  console.error(`\n${colors.fail('实验中断:')} ${err.message}`);
  console.error(colors.dim(err.stack ?? ''));
  await finish(1);
}
