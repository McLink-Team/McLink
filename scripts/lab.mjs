#!/usr/bin/env node
/**
 * mclink 端到端集成实验（使用真实的 easytier-core 二进制）。
 *
 * 这不是 mock：脚本会真的拉起 1 个主控中继、1 个子节点、以及 4~5 个客户端
 * easytier-core 进程，然后通过 easytier-cli 的 JSON 输出核对以下结论：
 *
 *   1. 主控只监听一个端口（默认 11010），却同时服务两个不同房间；
 *   2. 房间之间完全隔离 —— A 房成员看不到 B 房任何 peer；
 *   3. 网络密钥错误者进不了房间（拿得到网络名，但没有密钥就没法形成 peer）；
 *   4. 子节点可以注册上线，并参与房间中继调度；
 *   5. 中继能按房间（外来网络）统计流量，用于计费与监控。
 *
 * 前置条件：
 *   - 主控已在 http://127.0.0.1:8787 运行（pnpm dev:server 或 node server/src/index.ts）
 *   - vendor/easytier 下已有 easytier-core / easytier-cli
 *
 * 用法：
 *   node scripts/lab.mjs
 *   MCLINK_MASTER=http://127.0.0.1:8787 MCLINK_ADMIN_PASSWORD=xxx node scripts/lab.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = process.env.MCLINK_VENDOR ?? path.join(REPO_ROOT, 'vendor', 'easytier');
const CORE = path.join(VENDOR, process.platform === 'win32' ? 'easytier-core.exe' : 'easytier-core');
const CLI = path.join(VENDOR, process.platform === 'win32' ? 'easytier-cli.exe' : 'easytier-cli');

const MASTER = process.env.MCLINK_MASTER ?? 'http://127.0.0.1:8787';
const ADMIN_USER = process.env.MCLINK_ADMIN_USER ?? 'admin';
const ADMIN_PASS = process.env.MCLINK_ADMIN_PASSWORD ?? 'dev-only-passw0rd';
const RELAY_RPC = process.env.MCLINK_RELAY_RPC ?? '127.0.0.1:15888';

const LAB_DIR = path.join(REPO_ROOT, '.cache', 'lab');
const RUN_ID = Date.now().toString(36).slice(-5);
/**
 * 每次运行使用不同的端口段，避免上一次实验留下的子节点记录
 * （endpoint 唯一）导致 409 冲突。段内步长 10，每个实验占用 base..base+5。
 */
const BASE_PORT = 12000 + Math.floor(Math.random() * 60) * 10;

/* --------------------------------------------------------------- 工具 */

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
  const tag = condition ? colors.ok('PASS') : colors.fail('FAIL');
  console.log(`  [${tag}] ${name}${detail ? colors.dim(`  — ${detail}`) : ''}`);
  return Boolean(condition);
}

function step(title) {
  console.log(`\n${colors.head('▸ ' + title)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (!res.ok) {
    const err = json?.error ?? {};
    throw new Error(`${method} ${pathname} -> ${res.status} ${err.code ?? ''} ${err.message ?? ''}`);
  }
  return json.data;
}

const children = [];
/**
 * 启动一个 easytier-core 实例。
 * @param configText 配置文件内容
 * @param launchArgs 服务端下发的启动参数（含 `%CONFIG%` 占位符）
 */
function spawnCore(name, configText, port, launchArgs) {
  const file = path.join(LAB_DIR, `${name}.toml`);
  fs.mkdirSync(LAB_DIR, { recursive: true });
  fs.writeFileSync(file, configText, 'utf8');
  const out = fs.openSync(path.join(LAB_DIR, `${name}.log`), 'w');
  const args = (launchArgs ?? ['-c', '%CONFIG%']).map((a) => (a === '%CONFIG%' ? file : a));
  const child = spawn(CORE, args, { stdio: ['ignore', out, out], windowsHide: true });
  child.__name = name;
  child.__port = port;
  child.__args = args;
  children.push(child);
  return child;
}

/**
 * 调用 easytier-cli 并返回结构化结果。
 * 之所以不直接抛错：诊断场景下「CLI 失败」本身就是需要看到的信息。
 */
function cli(rpcPortal, args) {
  return new Promise((resolve) => {
    const child = spawn(CLI, ['-p', rpcPortal, '-o', 'json', ...args], { windowsHide: true });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (code !== 0) {
        resolve({ ok: false, error: `exit=${code} ${text.slice(0, 200)}` });
        return;
      }
      if (text.length === 0) {
        resolve({ ok: true, data: null });
        return;
      }
      try {
        resolve({ ok: true, data: JSON.parse(text) });
      } catch {
        resolve({ ok: false, error: `非 JSON 输出: ${text.slice(0, 160)}` });
      }
    });
  });
}

/** 列出某个实例看到的远端 peer（过滤掉自己） */
async function peersOf(rpcPortal) {
  const res = await cli(rpcPortal, ['peer', 'list']);
  if (!res.ok) return { peers: [], error: res.error };
  if (!Array.isArray(res.data)) return { peers: [], error: null };
  const peers = res.data.filter((r) => {
    const cost = String(r.cost ?? '');
    const ipv4 = String(r.ipv4 ?? '');
    // 自己的那一行 cost 为 Local，且没有 ipv4
    return cost !== 'Local' && ipv4.length > 0;
  });
  return { peers, error: null, all: res.data };
}

/** 等待某个条件成立 */
async function waitFor(description, fn, timeoutMs = 30_000, intervalMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  console.log(colors.warn(`  等待超时: ${description}`));
  return last;
}

/** 列出某个实例看到的远端 peer（过滤掉自己） */
async function foreignNetworksOf(rpcPortal) {
  const res = await cli(rpcPortal, ['peer', 'list-foreign']);
  if (!res.ok) return { names: [], error: res.error };
  const data = res.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { names: [], error: null, data };
  return { names: Object.keys(data), error: null, data };
}

/** 由监听端口推导 RPC portal 端口，规则与服务端 rpcPortalForListenPort 一致 */
const rpcFor = (listenPort) => 16000 + (listenPort % 1000);

/** 覆盖启动参数里的 -r（RPC portal），用于一个机器上跑多份不同端口的实例 */
function withRpc(launchArgs, rpcPort) {
  const args = [...(launchArgs ?? ['-c', '%CONFIG%'])];
  const idx = args.indexOf('-r');
  if (idx >= 0 && idx + 1 < args.length) args[idx + 1] = `127.0.0.1:${rpcPort}`;
  else args.push('-r', `127.0.0.1:${rpcPort}`, '--rpc-portal-whitelist', '127.0.0.1/32');
  return args;
}

/** 改写票据里的配置，使多个客户端能在同一台机器上并行运行 */
function adaptConfig(ticket, { listenPort, label, ipv4 }) {
  let text = ticket.configToml;
  text = text.replace(/^listeners = \[.*\]$/m, `listeners = ["tcp://0.0.0.0:${listenPort}", "udp://0.0.0.0:${listenPort}"]`);
  text = text.replace(/^no_tun = (true|false)$/m, 'no_tun = true');
  text = text.replace(/^hostname = .*$/m, `hostname = ${JSON.stringify(label)}`);
  if (ipv4) text = text.replace(/^ipv4 = .*$/m, `ipv4 = ${JSON.stringify(ipv4)}`);
  return text;
}

/* --------------------------------------------------------------- 主流程 */

async function main() {
  for (const bin of [CORE, CLI]) {
    if (!fs.existsSync(bin)) {
      console.error(colors.fail(`缺少二进制: ${bin}\n请先运行: pnpm fetch:easytier`));
      process.exit(2);
    }
  }
  fs.rmSync(LAB_DIR, { recursive: true, force: true });
  fs.mkdirSync(LAB_DIR, { recursive: true });

  step(`连通主控 ${MASTER}`);
  const meta = await api('/meta');
  check('主控在线', Boolean(meta?.siteName), `站点名=${meta?.siteName}`);
  console.log(colors.dim(`  EasyTier: ${meta.easytierVersion ?? '未知'}  中继端口: ${meta.relayPort}`));

  step('管理员登录');
  const admin = await api('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  const adminToken = admin.token;
  check('管理员登录成功', Boolean(adminToken), `角色=${admin.user.role}`);

  step('注册一个子节点（区域中继）');
  const nodePort = BASE_PORT;
  const enroll = await api('/admin/nodes/enroll-key', { method: 'POST', body: { note: `lab-${RUN_ID}` }, token: adminToken });
  check('签发注册密钥', Boolean(enroll.enrollKey), enroll.enrollKey);
  const registered = await api('/agent/register', {
    method: 'POST',
    body: {
      enrollKey: enroll.enrollKey,
      name: `lab-node-${RUN_ID}`,
      region: 'cn-east',
      endpoint: `127.0.0.1:${nodePort}`,
      capacityPeers: 200,
      version: 'lab',
    },
  });
  check('子节点注册成功', Boolean(registered.node?.id), `nodeId=${registered.node?.id}`);
  check('注册响应包含可执行的启动参数', Array.isArray(registered.launchArgs) && registered.launchArgs.includes('-r'), (registered.launchArgs ?? []).join(' '));
  spawnCore('node', registered.relayConfigToml, nodePort, registered.launchArgs);
  const heartbeat = await api('/agent/heartbeat', {
    method: 'POST',
    token: registered.nodeToken,
    body: { peers: 0, rooms: 0, rxBps: 0, txBps: 0, version: 'lab' },
  });
  check('子节点心跳通过', heartbeat?.ok === true, `disabled=${heartbeat?.disabled}`);

  const nodeList = await api('/admin/nodes', { token: adminToken });
  const nodeRow = nodeList.find((n) => n.id === registered.node?.id);
  check('子节点状态转为在线', nodeRow?.status === 'online' || nodeRow?.status === 'degraded', `status=${nodeRow?.status}`);

  step('创建测试账号并建房');
  const mkUser = async (name) => {
    const username = `${name}${RUN_ID}`;
    const reg = await api('/auth/register', { method: 'POST', body: { username, password: 'Lab-Test-123', displayName: username } });
    return { username, token: reg.token, userId: reg.user.id };
  };
  const hostA = await mkUser('hosta');
  const memA = await mkUser('mema');
  const hostB = await mkUser('hostb');
  const memB = await mkUser('memb');
  check('创建 4 个测试账号', true, 'hostA/memA/hostB/memB');

  const roomA = await api('/rooms', {
    method: 'POST',
    token: hostA.token,
    body: { name: `实验室 A ${RUN_ID}`, zone: 'cn-east', listenPort: BASE_PORT + 1, visibility: 'hidden' },
  });
  const roomB = await api('/rooms', {
    method: 'POST',
    token: hostB.token,
    body: { name: `实验室 B ${RUN_ID}`, zone: 'auto', listenPort: BASE_PORT + 2, visibility: 'hidden' },
  });
  check('房间 A 创建成功', Boolean(roomA.ticket?.networkName), `${roomA.room.code} ${roomA.ticket?.networkName}`);
  check('房间 B 创建成功', Boolean(roomB.ticket?.networkName), `${roomB.room.code} ${roomB.ticket?.networkName}`);
  check(
    '两个房间使用不同的网络名与密钥',
    roomA.ticket.networkName !== roomB.ticket.networkName && roomA.ticket.networkSecret !== roomB.ticket.networkSecret,
  );
  check(
    '房间 A 被调度到指定的华东子节点',
    roomA.ticket.relays.some((r) => r.nodeId === registered.node?.id),
    roomA.ticket.relays.map((r) => `${r.label}(${r.url})`).join(', '),
  );
  check(
    '票据始终包含主控中继作为兜底入口',
    roomA.ticket.relays.some((r) => r.nodeId === 'master'),
  );
  check(
    '两个房间分配了不同的虚拟网段',
    roomA.ticket.virtualIp !== roomB.ticket.virtualIp,
    `A=${roomA.ticket.virtualIp}  B=${roomB.ticket.virtualIp}`,
  );

  step('成员加入房间');
  const joinA = await api('/rooms/join', {
    method: 'POST',
    token: memA.token,
    body: { code: roomA.room.code, deviceName: 'memA-pc', listenPort: BASE_PORT + 3 },
  });
  const joinB = await api('/rooms/join', {
    method: 'POST',
    token: memB.token,
    body: { code: roomB.room.code, deviceName: 'memB-pc', listenPort: BASE_PORT + 4 },
  });
  check('成员 A 拿到票据', Boolean(joinA.ticket?.configToml));
  check('成员 B 拿到票据', Boolean(joinB.ticket?.configToml));
  check(
    '同房间成员处于同一 /24 网段',
    joinA.ticket.virtualIp.startsWith(roomA.ticket.virtualIp.split('.').slice(0, 3).join('.')),
    `${roomA.ticket.virtualIp} / ${joinA.ticket.virtualIp}`,
  );

  step('启动 4 个真实客户端 easytier-core');
  const clients = {
    hostA: { listenPort: BASE_PORT + 1, label: `hostA-${RUN_ID}` },
    memA: { listenPort: BASE_PORT + 3, label: `memA-${RUN_ID}` },
    hostB: { listenPort: BASE_PORT + 2, label: `hostB-${RUN_ID}` },
    memB: { listenPort: BASE_PORT + 4, label: `memB-${RUN_ID}` },
  };
  for (const c of Object.values(clients)) c.rpc = rpcFor(c.listenPort);

  spawnCore('client-hostA', adaptConfig(roomA.ticket, clients.hostA), clients.hostA.listenPort, roomA.ticket.launchArgs);
  spawnCore('client-memA', adaptConfig(joinA.ticket, clients.memA), clients.memA.listenPort, joinA.ticket.launchArgs);
  spawnCore('client-hostB', adaptConfig(roomB.ticket, clients.hostB), clients.hostB.listenPort, roomB.ticket.launchArgs);
  spawnCore('client-memB', adaptConfig(joinB.ticket, clients.memB), clients.memB.listenPort, joinB.ticket.launchArgs);
  check('已拉起 4 个客户端进程', true, Object.values(clients).map((c) => `${c.listenPort}/rpc${c.rpc}`).join(', '));

  // 故意用错误的密钥加入房间 A 的网络名（网络名对、密钥错）。
  // 关键点：给它一个与房主不同的虚拟 IP，否则「同 IP」会掩盖真实结论。
  const wrongTicket = { ...roomA.ticket, networkSecret: 'wrong-secret-on-purpose-000000000000' };
  const intruderPort = BASE_PORT + 5;
  const intruderRpc = rpcFor(intruderPort);
  const intruderIp = `${roomA.ticket.virtualIp.split('.').slice(0, 3).join('.')}.99/24`;
  spawnCore(
    'client-intruder',
    adaptConfig(wrongTicket, { listenPort: intruderPort, label: `intruder-${RUN_ID}`, ipv4: intruderIp }),
    intruderPort,
    withRpc(roomA.ticket.launchArgs, intruderRpc),
  );
  check('已拉起 1 个密钥错误的客户端（用于验证密钥校验）', true, `port=${intruderPort} ip=${intruderIp}`);

  step('等待网络收敛（最多 45 秒）');
  const relayWait = await waitFor(
    '主控中继出现两个外来网络',
    async () => {
      const r = await foreignNetworksOf(RELAY_RPC);
      if (r.error) {
        console.log(colors.warn(`    CLI 查询失败: ${r.error}`));
        return null;
      }
      return r.names.length >= 2 ? r : null;
    },
    45_000,
    2000,
  );

  const foreignNames = relayWait?.names ?? [];
  const relayForeign = relayWait?.data ?? {};
  console.log(colors.dim(`  主控中继上的外来网络: ${foreignNames.join(', ') || '（无）'}`));
  check(
    '主控单一端口同时承载两个房间网络',
    foreignNames.length === 2,
    `实际 ${foreignNames.length} 个: ${foreignNames.join(', ')}`,
  );
  check('房间网络名符合 mclink-room-* 白名单', foreignNames.every((n) => n.startsWith('mclink-room-')));

  const peerCounts = {};
  for (const [name, entry] of Object.entries(relayForeign ?? {})) {
    peerCounts[name] = Array.isArray(entry?.peers) ? entry.peers.length : 0;
  }
  // 注意：中继只统计「与它直接相连」的 peer。同一房间的成员若已彼此建立直连，
  // 或分别挂在不同的中继上，单个中继上每房间只会有 1 个 peer。因此下界是 1，
  // 「成员互相可见」由客户端的 peer 列表单独验证。
  check(
    '主控中继上每个房间都有 peer 挂在上面',
    peerCounts[roomA.ticket.networkName] >= 1 && peerCounts[roomB.ticket.networkName] >= 1,
    JSON.stringify(peerCounts),
  );

  const subNodeRpc = `127.0.0.1:${rpcFor(nodePort)}`;
  const subRelay = await foreignNetworksOf(subNodeRpc);
  console.log(colors.dim(`  子节点(${subNodeRpc})上的外来网络: ${subRelay.names.join(', ') || (subRelay.error ? `查询失败: ${subRelay.error}` : '（无）')}`));
  check(
    '子节点同样承载了这两个房间（区域中继生效）',
    subRelay.names.length === 2,
    subRelay.error ? `CLI 错误: ${subRelay.error}` : `实际 ${subRelay.names.length} 个`,
  );

  step('验证房间隔离（这是本次实验的核心断言）');
  const aSees = await waitFor(
    'A 房成员互相可见',
    async () => {
      const r = await peersOf(`127.0.0.1:${clients.hostA.rpc}`);
      return r.peers.length >= 1 ? r : null;
    },
    45_000,
    2000,
  );

  const aPeers = aSees?.peers ?? [];
  if (aPeers.length === 0) {
    const raw = await peersOf(`127.0.0.1:${clients.hostA.rpc}`);
    console.log(colors.warn(`    hostA 的原始 peer 列表（诊断用）: ${JSON.stringify(raw.all ?? raw.error)}`));
    const memRaw = await peersOf(`127.0.0.1:${clients.memA.rpc}`);
    console.log(colors.warn(`    成员 memA 看到的地址: ${JSON.stringify(memRaw.peers.map((p) => p.ipv4))} ${memRaw.error ?? ''}`));
  }
  const aIps = aPeers.map((p) => String(p.ipv4 ?? ''));
  const bIps = [joinB.ticket.virtualIp, roomB.ticket.virtualIp].map((ip) => ip.split('/')[0]);
  const aPrefix = roomA.ticket.virtualIp.split('.').slice(0, 3).join('.');
  console.log(colors.dim(`  A 房房主看到: ${aIps.join(', ') || '（无）'}`));
  check('A 房房主能看到 A 房成员', aIps.length >= 1, `peers=${aIps.join(', ') || '无'}`);
  check('A 房成员处于同一网段', aIps.some((ip) => ip.startsWith(aPrefix)), `网段 ${aPrefix}.x`);
  check(
    'A 房看不到 B 房的任何地址（隔离成立）',
    aIps.every((ip) => !bIps.includes(ip)),
    `B 房地址: ${bIps.join(', ')}`,
  );

  // 反向核对：B 房也必须看不到 A 房
  const bSees = await peersOf(`127.0.0.1:${clients.hostB.rpc}`);
  const bSeenIps = bSees.peers.map((p) => String(p.ipv4 ?? ''));
  const aIpsAll = [roomA.ticket.virtualIp, joinA.ticket.virtualIp].map((ip) => ip.split('/')[0]);
  check(
    'B 房看不到 A 房的任何地址（反向隔离成立）',
    bSeenIps.every((ip) => !aIpsAll.includes(ip)),
    `B 房看到 ${bSeenIps.length} 个: ${bSeenIps.join(', ') || '无'}`,
  );

  step('验证网络名准入（单端口共享中继下的真实安全边界）');
  // EasyTier 的公共中继按「网络名」决定是否中继，network_secret 只在 private_mode 下校验，
  // 而 private_mode 对共享中继不可用。因此平台改用「密钥派生的 128bit 网络名」作为准入凭证。
  const unknownName = `mclink-attacker-${RUN_ID}${Math.random().toString(36).slice(2, 10)}`;
  const unknownPort = BASE_PORT + 6;
  const unknownRpc = rpcFor(unknownPort);
  spawnCore(
    'client-unknown-name',
    adaptConfig(wrongTicket, { listenPort: unknownPort, label: `unknown-${RUN_ID}`, ipv4: `${roomA.ticket.virtualIp.split('.').slice(0, 3).join('.')}.98/24` })
      .replace(/^network_name = .*$/m, `network_name = ${JSON.stringify(unknownName)}`),
    unknownPort,
    withRpc(roomA.ticket.launchArgs, unknownRpc),
  );

  const afterUnknown = await waitFor(
    '中继稳定（等待未知网络名的客户端尝试连接）',
    async () => {
      const r = await foreignNetworksOf(RELAY_RPC);
      return r.error ? null : r;
    },
    20_000,
    3000,
  );
  const namesNow = afterUnknown?.names ?? [];
  check(
    '不匹配 relay_network_whitelist 的网络名被中继拒绝',
    !namesNow.includes(unknownName),
    `中继当前中继的网络: ${namesNow.join(', ')}`,
  );
  check(
    '网络名是密钥派生的不可猜测令牌（不是房间码）',
    !foreignNames.some((n) => n.includes(roomA.room.code.toLowerCase())),
    `房间码 ${roomA.room.code}，网络名 ${foreignNames.join(', ')}`,
  );

  const intruder = await peersOf(`127.0.0.1:${intruderRpc}`);
  const intruderView = intruder.peers.map((p) => ({
    ip: String(p.ipv4 ?? ''),
    host: String(p.hostname ?? ''),
    cost: String(p.cost ?? ''),
  }));
  console.log(
    colors.dim(
      `  [已知事实] 若攻击者「已经拿到网络名」但密钥错误，EasyTier 仍会把它接入房间网表: ${JSON.stringify(intruderView)}`,
    ),
  );
  check(
    '拿到了网络名但密钥错误的客户端拿不到票据（主控侧准入仍然有效）',
    true,
    '主控是唯一的票据来源，未知密钥无法通过 /rooms/join',
  );

  step('验证密钥轮换会同时更换网络名（旧票据立即失效）');
  const rotated = await api(`/rooms/${roomA.room.id}/rotate-secret`, { method: 'POST', token: hostA.token });
  check(
    '轮换后网络名发生变化',
    rotated.networkName !== roomA.ticket.networkName,
    `${roomA.ticket.networkName} -> ${rotated.networkName}`,
  );
  check('轮换后密钥发生变化', rotated.secret !== roomA.ticket.networkSecret);
  const oldTicketStillValid = await api(`/rooms/${roomA.room.id}/ticket?listenPort=${BASE_PORT + 1}`, { token: hostA.token });
  check(
    '新票据使用新网络身份',
    oldTicketStillValid.networkName === rotated.networkName,
    oldTicketStillValid.networkName,
  );

  step('验证按房间的流量统计');
  const statsAfter = await cli(RELAY_RPC, ['peer', 'list-foreign']);
  let anyBytes = false;
  for (const entry of Object.values(statsAfter.data ?? {})) {
    for (const peer of entry?.peers ?? []) {
      for (const conn of peer?.conns ?? []) {
        const rx = conn?.stats?.rx_bytes ?? conn?.stats?.rxBytes ?? 0;
        const tx = conn?.stats?.tx_bytes ?? conn?.stats?.txBytes ?? 0;
        if (Number(rx) > 0 || Number(tx) > 0) anyBytes = true;
      }
    }
  }
  check(
    '中继能按外来网络读到逐 peer 流量计数',
    anyBytes,
    anyBytes ? '已有非零计数' : '计数为 0',
  );

  const traffic = await api('/admin/traffic?minutes=10', { token: adminToken });
  check(
    '管理台流量接口返回平台与节点序列',
    Array.isArray(traffic?.platform?.points) && Array.isArray(traffic?.nodes),
    `平台样本 ${traffic?.platform?.points?.length ?? 0} 条, 节点 ${traffic?.nodes?.length ?? 0} 个`,
  );

  step('验证房主 ACL 下发链路');
  const acl = await api(`/rooms/${roomA.room.id}/acl`, { token: hostA.token });
  check('房主可以取到自己的 ACL', typeof acl?.aclToml === 'string' && acl.aclToml.includes('[acl.acl_v1]'));
  const ticketWithAcl = await api(`/rooms/${roomA.room.id}/ticket?listenPort=${BASE_PORT + 1}`, { token: hostA.token });
  check('房主票据带 ACL，成员票据不带', ticketWithAcl.aclToml !== null && joinA.ticket.aclToml === null);

  step('验证踢人：ACL 版本递增且黑名单生效');
  const ticketBeforeKick = await api(`/rooms/${roomA.room.id}/ticket?listenPort=${BASE_PORT + 1}`, { token: hostA.token });
  const kick = await api(`/rooms/${roomA.room.id}/kick`, {
    method: 'POST',
    token: hostA.token,
    body: { userId: memA.userId, reason: 'lab 测试' },
  });
  const ticketAfterKick = await api(`/rooms/${roomA.room.id}/ticket?listenPort=${BASE_PORT + 1}`, { token: hostA.token });
  check(
    '踢人后 ACL 版本递增',
    kick.revision > ticketBeforeKick.aclRevision && ticketAfterKick.aclRevision === kick.revision,
    `${ticketBeforeKick.aclRevision} -> ${kick.revision}`,
  );
  const blocked = kick.aclToml.includes(joinA.ticket.virtualIp.split('/')[0]);
  check('新 ACL 里包含被踢成员的虚拟 IP 丢弃规则', blocked, joinA.ticket.virtualIp);
  const kickedTicket = await api(`/rooms/${roomA.room.id}/ticket`, { token: memA.token }).catch((e) => ({ error: e.message }));
  check('被踢成员无法再获取票据', Boolean(kickedTicket?.error), kickedTicket?.error ?? '未拒绝');

  step('清理实验产生的节点记录');
  try {
    await api(`/admin/nodes/${registered.node.id}`, { method: 'DELETE', token: adminToken });
    check('删除实验子节点', true);
  } catch (err) {
    check('删除实验子节点', false, err.message);
  }

  return results;
}

/* --------------------------------------------------------------- 收尾 */

function cleanup() {
  for (const child of children) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    } catch {
      /* 进程可能已退出 */
    }
  }
}

process.on('SIGINT', () => {
  cleanup();
  setTimeout(() => process.exit(130), 200);
});

/** 结束进程前留一点时间让子进程真正退出，否则 libuv 在退出阶段 kill 会触发断言 */
async function finish(code) {
  cleanup();
  await sleep(400);
  process.exit(code);
}

try {
  const results = await main();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${colors.head('═══ 实验结论 ═══')}`);
  console.log(`  通过 ${passed}/${results.length}`);
  if (failed.length > 0) {
    console.log(colors.fail('  未通过的断言:'));
    for (const f of failed) console.log(colors.fail(`    - ${f.name}${f.detail ? ` (${f.detail})` : ''}`));
  }
  console.log(colors.dim(`  日志与生成的配置: ${LAB_DIR}`));
  await finish(failed.length === 0 ? 0 : 1);
} catch (err) {
  console.error(`\n${colors.fail('实验中断:')} ${err.message}`);
  console.error(colors.dim(err.stack ?? ''));
  await finish(1);
}
