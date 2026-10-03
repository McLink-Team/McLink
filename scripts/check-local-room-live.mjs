#!/usr/bin/env node
/**
 * 活体检查：**本地联机（免主控）真的能通吗**。
 *
 * 为什么必须有这一条：这条路没有主控兜底 —— 配置写错一个字，玩家看到的就是"连不上"，
 * 而没有任何服务端日志能帮他查。所以这里不满足于"TOML 看起来对"：
 * 起**两个真实的 easytier-core 实例**（都用 `client/src/lib/local-room.ts` 生成的配置），
 * 在一个**本机监听的中继**上牵手，然后用 `easytier-cli peer list` 断言：
 *   1. 两个实例都起来了、都认同一个网络名；
 *   2. 加入方（dhcp）拿到了房主网段里的地址（说明房主的 DHCP 生效）；
 *   3. 两边互相看得见对方（peer 列表里出现对方的虚拟 IP）——
 *      这就是"填个中继地址就能直接用"的实质。
 *
 * 为了不依赖外网，中继用**第三个本地实例**扮演（社区公共服的角色就是"能被双方连上")；
 * 真实使用里把 `--relay` 换成 `public.easytier.cn:11010` 这类地址即可。
 *
 * 用法：
 *   node scripts/check-local-room-live.mjs                # Windows 开发机默认路径
 *   node scripts/check-local-room-live.mjs --keep         # 保留临时目录（排查用）
 *   node scripts/check-local-room-live.mjs --relay host:port   # 用外部中继（跳过本地中转实例）
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  hostVirtualIp,
  newNetworkName,
  newRoomSecret,
  renderLocalRoomToml,
} from '../client/src/lib/local-room.ts';
const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const RELAY_ARG = args.includes('--relay') ? args[args.indexOf('--relay') + 1] : null;

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const VENDOR = path.join(REPO, 'vendor', 'easytier');
const CORE = path.join(VENDOR, process.platform === 'win32' ? 'easytier-core.exe' : 'easytier-core');
const CLI = path.join(VENDOR, process.platform === 'win32' ? 'easytier-cli.exe' : 'easytier-cli');
if (!fs.existsSync(CORE) || !fs.existsSync(CLI)) {
  console.error(`找不到 EasyTier 核心：${CORE}\n先跑：node scripts/fetch-easytier.mjs --windows`);
  process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`);
};

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mclink-local-'));
console.log(`临时目录：${workDir}`);

/**
 * 中转地址**必须用本机的局域网 IP**，不能用 127.0.0.1。
 *
 * 实测踩过：节点带虚拟 IP（`ipv4 = "10.126.126.1/24"`）时去连 `tcp://127.0.0.1:41500`，
 * EasyTier 会以 `WSAEADDRNOTAVAIL (10049，地址无效)` 失败 —— 它把源地址绑到虚拟网卡上，
 * 而"源 = 10.126.126.1、目标 = 127.0.0.1"在 Windows 上不成立。
 * 真实使用里中继都是远端主机，不会碰到；这条只影响"在本机起一个中转做检查"的写法。
 */
const lanIp = (() => {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return null;
})();
if (!lanIp) {
  console.error('找不到本机局域网 IPv4 —— 这个检查需要它来当中转地址（见脚本里的说明）');
  process.exit(2);
}
console.log(`本机局域网 IP：${lanIp}（用它的地址当中转，不用 127.0.0.1）`);

const children = [];
function startCore(name, toml, rpcPort, extraArgs = []) {
  const cfg = path.join(workDir, `${name}.toml`);
  fs.writeFileSync(cfg, toml, 'utf8');
  const args2 = ['-c', cfg, '--rpc-portal', `127.0.0.1:${rpcPort}`, ...extraArgs];
  const child = spawn(CORE, args2, { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
  const logPath = path.join(workDir, `${name}.log`);
  const out = fs.createWriteStream(logPath);
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.push(child);
  console.log(`  启动 ${name}: rpc=127.0.0.1:${rpcPort} 日志=${logPath}`);
  return child;
}

function cli(args2, rpcPort) {
  const res = spawnSync(CLI, ['-p', `127.0.0.1:${rpcPort}`, '-o', 'json', ...args2], { encoding: 'utf8', timeout: 15_000 });
  if (res.status !== 0) return { error: (res.stderr || res.stdout || '').slice(-200), raw: res.stdout };
  try {
    return { json: JSON.parse(res.stdout) };
  } catch {
    return { raw: res.stdout };
  }
}

async function waitFor(fn, { tries = 30, gap = 1000, what = '条件' } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn();
    if (value) return value;
    await delay(gap);
  }
  console.log(`  （等待超时：${what}）`);
  return null;
}

try {
  /* ------------------------------------------------ 1. 起一个"社区中继"扮演中间人 */

  const relayPort = 41010;
  const relayRpc = 41580;
  if (!RELAY_ARG) {
    const relayToml = [
      'instance_name = "mclink-relay-standin"',
      `listeners = ["tcp://0.0.0.0:${relayPort}", "udp://0.0.0.0:${relayPort}"]`,
      '',
      '[network_identity]',
      'network_name = "mclink-relay-standin"',
      `network_secret = "${newRoomSecret()}"`,
      '',
      '[flags]',
      'enable_encryption = true',
      'enable_ipv6 = false',
      // 中继要转发**别人**的网络：白名单放开（社区公共服通常就是这个配置）
      'relay_network_whitelist = "*"',
      '',
    ].join('\n');
    startCore('relay', relayToml, relayRpc);
  } else {
    console.log(`  使用外部中继：${RELAY_ARG}`);
  }

  /* ------------------------------------------------ 2. 房主与加入方用本地联机配置 */

  const spec = {
    title: '本地联机检查',
    networkName: newNetworkName('本地联机检查'),
    secret: newRoomSecret(),
    peers: RELAY_ARG ? [RELAY_ARG] : [`tcp://${lanIp}:${relayPort}`, `udp://${lanIp}:${relayPort}`],
    isHost: true,
    hostIp: hostVirtualIp(),
  };
  console.log(`  房间：${spec.title}  网络名=${spec.networkName}`);

  const hostRpc = 41581;
  const guestRpc = 41582;
  startCore('host', renderLocalRoomToml({ spec, hostname: 'host-pc', listenPort: 41011 }), hostRpc);
  startCore(
    'guest',
    renderLocalRoomToml({ spec: { ...spec, isHost: false }, hostname: 'guest-pc', listenPort: 41012 }),
    guestRpc,
  );

  /* ------------------------------------------------ 3. 断言 */

  const hostInfo = await waitFor(
    () => cli(['node', 'info'], hostRpc).json,
    { what: '房主实例起来并回 node info', tries: 40 },
  );
  check('房主实例启动成功（node info 可读）', Boolean(hostInfo), hostInfo ? '' : '读不到 node info');
  // 字段名可能随版本变（ipv4 / virtual_ipv4 / 嵌套在 interfaces 里）—— 先看看到手的是什么
  console.log(`    房主 node info：${JSON.stringify(hostInfo)?.slice(0, 300)}`);

  /** 从 node info 里尽力取出虚拟 IPv4（兼容几种字段形态） */
  const ipv4Of = (info) => {
    if (!info || typeof info !== 'object') return '';
    // 实测 2.6.4 的字段名是 `ipv4_addr`（不是 ipv4）—— 这里把几种形态都兼容掉
    const direct = info.ipv4_addr ?? info.ipv4 ?? info.virtual_ipv4 ?? info.virtualIpv4;
    if (typeof direct === 'string' && direct.length > 0) return direct;
    const ifaces = info.interfaces;
    if (Array.isArray(ifaces)) {
      for (const it of ifaces) {
        const ip = it?.ipv4 ?? it?.ip;
        if (typeof ip === 'string' && /^10\.126\.126\./.test(ip)) return ip;
      }
    }
    // 最后兜底：整份 JSON 里找 10.126.126.x
    const m = /10\.126\.126\.\d+/.exec(JSON.stringify(info));
    return m?.[0] ?? '';
  };

  const hostIp = ipv4Of(hostInfo);
  check('房主拿到固定虚拟地址 10.126.126.1', hostIp.split('/')[0] === '10.126.126.1', `ipv4=${hostIp}`);

  const guestInfo = await waitFor(
    () => cli(['node', 'info'], guestRpc).json,
    { what: '加入方实例起来并回 node info', tries: 40 },
  );
  const guestIp = ipv4Of(guestInfo);
  check(
    '加入方也拿到同网段地址（静态分配，见 local-room.ts 的说明）',
    /^10\.126\.126\.\d+/.test(guestIp) && guestIp.split('/')[0] !== '10.126.126.1',
    `guest ipv4=${guestIp}（原始：${JSON.stringify(guestInfo)?.slice(0, 160)}）`,
  );

  /**
   * peer list 里有没有**某个虚拟 IP**。
   *
   * ⚠️ 两个坑都在这几行里踩过，所以写成现在这样：
   *   · `node info` 给的是 `10.126.126.1/24`（带掩码），peer list 给的是 `10.126.126.1`（不带）
   *     → 两边都先 `split('/')[0]`；
   *   · **必须比相等，不能用 startsWith**：`10.126.126.168` 也是以 `10.126.126.1` 开头的
   *     → 用前缀比会把"自己"当成"对方"，得到一条假通过。
   */
  const bare = (ip) => String(ip).split('/')[0];
  const peerListHas = (rpcPort, ip) => {
    if (bare(ip).length === 0) return null;
    const res = cli(['peer', 'list'], rpcPort).json;
    const list = Array.isArray(res) ? res : (res?.peers ?? []);
    return list.some((p) => bare(p.ipv4) === bare(ip)) ? list : null;
  };

  // 双方互相看得见（各自 peer list 里出现对方的虚拟地址）
  const hostSeesGuest = await waitFor(() => peerListHas(hostRpc, guestIp), { what: '房主看到加入方', tries: 40 });
  if (hostSeesGuest) console.log(`    房主 peer：${hostSeesGuest.map((p) => `${bare(p.ipv4)}/${p.cost}`).join('  ')}`);
  check('房主看得见加入方', Boolean(hostSeesGuest), hostSeesGuest ? `${hostSeesGuest.length} 条 peer` : '没等到');

  const guestSeesHost = await waitFor(() => peerListHas(guestRpc, '10.126.126.1'), { what: '加入方看到房主', tries: 40 });
  if (guestSeesHost) console.log(`    加入方 peer：${guestSeesHost.map((p) => `${bare(p.ipv4)}/${p.cost}`).join('  ')}`);
  check('加入方看得见房主（能连游戏）', Boolean(guestSeesHost), guestSeesHost ? `${guestSeesHost.length} 条 peer` : '没等到');

  if (guestSeesHost) {
    const row = guestSeesHost.find((p) => bare(p.ipv4) === '10.126.126.1');
    console.log(`    加入方看到的房主：ipv4=${row.ipv4} cost=${row.cost} latency=${row.lat_ms ?? row.latency_ms ?? '—'}`);
  }
} finally {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  }
  await delay(500);
  if (KEEP) console.log(`保留临时目录：${workDir}`);
  else fs.rmSync(workDir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
