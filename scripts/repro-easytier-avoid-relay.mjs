#!/usr/bin/env node
/**
 * 本地复现：EasyTier 的 avoid-relay 惩罚在什么条件下失效。
 *
 * 背景（线上实测）：两台中继节点，其中一台标了 `disable_relay_data = true`（→ 广播
 * `avoid_relay_data`），两端与两台**都**是 p2p 直连、同为 2 跳，但两端到对方的 `route`
 * 仍然选那台被标记的节点，数据被它丢掉 → 房间不通。改 `latency_first = true` 也没用。
 *
 * 这个脚本在**一台机器上**摆出同样的拓扑（两台"服务器" + 两个客户端，客户端用
 * `disable_p2p = true` 强制走中继），跑多种组合，看 `easytier-cli route` 里到对端的
 * `next_hop` 到底是谁 —— 从而判断"标志没广告出去"还是"选路没吃它"。
 *
 * 用法：
 *   node scripts/repro-easytier-avoid-relay.mjs                 # 用 vendor/easytier 的二进制
 *   ET_DIR=/path/to/easytier node scripts/repro-easytier-avoid-relay.mjs
 *   node scripts/repro-easytier-avoid-relay.mjs --case=marked-latency-first
 *
 * 退出码：0 = 行为符合预期（标记的那台被绕开）；1 = 复现了 bug。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const ET_DIR = process.env.ET_DIR ?? path.join(REPO, 'vendor', 'easytier');
const suffix = process.platform === 'win32' ? '.exe' : '';
const CORE = path.join(ET_DIR, `easytier-core${suffix}`);
const CLI = path.join(ET_DIR, `easytier-cli${suffix}`);
const SECRET = '00'.repeat(32);

const RELAY_NET = 'mclink-master-node';
const ROOM_NET = 'mclink-room-repro';

/** 端口分配：relayA / relayB / client1 / client2 */
const P = {
  relayA: { listen: 21001, rpc: 15801 },
  relayB: { listen: 21002, rpc: 15802 },
  client1: { listen: 21011, rpc: 15811 },
  client2: { listen: 21012, rpc: 15812 },
};

/**
 * 四种组合。`expect` 是**应该**出现的结果，用来一眼看出哪一档开始不对。
 * · marked        → relayA 是否标了 disable_relay_data
 * · latencyFirst  → 客户端是否 latency_first = true
 * · onlyMarked    → 票据里是否只有 relayA（没有替代路径时的对照）
 */
const CASES = [
  { name: 'marked-hop', marked: true, latencyFirst: false, onlyMarked: false, expect: 'relayB' },
  { name: 'marked-latency-first', marked: true, latencyFirst: true, onlyMarked: false, expect: 'relayB' },
  { name: 'unmarked-latency-first', marked: false, latencyFirst: true, onlyMarked: false, expect: 'either' },
  { name: 'marked-only-path', marked: true, latencyFirst: true, onlyMarked: true, expect: 'relayA' },
  /*
   * 二分用：把两台"服务器"改成**房间网络里的普通成员**（不再是 relay 外来网络的服务端）。
   * 如果这一档里被标记的 relayA 被绕开了，说明标志在"同网 peer"之间传播没问题，
   * 缺口就在"外来网络 / public server"这条链上。
   */
  { name: 'member-marked-latency-first', marked: true, latencyFirst: true, onlyMarked: false, members: true, expect: 'relayB' },
];

const wanted = process.argv.find((a) => a.startsWith('--case='))?.slice(7);
/** --keep：保留临时目录（里面每个实例一份 .log，含打补丁构建的 [mclink-probe] 探针） */
const KEEP = process.argv.includes('--keep');
/** --keep 时也顺带打印探针汇总 */
for (const c of CASES) if (KEEP) c.keepLogs = true;
const cases = wanted ? CASES.filter((c) => c.name === wanted) : CASES;
if (cases.length === 0) {
  console.error(`没有匹配的用例：${wanted}（可选：${CASES.map((c) => c.name).join(', ')}）`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function relayToml(name, port, marked, latencyFirst, asMember) {
  if (asMember) {
    // 房间网络里的普通成员（不是 relay 外来网络的服务端）—— 用来二分定位
    return [
      `instance_name = "${name}"`,
      `hostname = "${name}"`,
      `dhcp = false`,
      `ipv4 = "${name === 'relayA' ? '10.199.0.11/24' : '10.199.0.12/24'}"`,
      `listeners = ["tcp://0.0.0.0:${port.listen}", "udp://0.0.0.0:${port.listen}"]`,
      `console_log_level = "warn"`,
      '',
      '[network_identity]',
      `network_name = "${ROOM_NET}"`,
      `network_secret = "${SECRET}"`,
      '',
      '[flags]',
      'no_tun = true',
      'enable_encryption = true',
      'bind_device = false',
      ...(latencyFirst ? ['latency_first = true'] : []),
      ...(marked ? ['disable_relay_data = true'] : []),
      '',
    ].join('\n');
  }
  return [
    `instance_name = "${name}"`,
    `hostname = "${name}"`,
    `dhcp = false`,
    `listeners = ["tcp://0.0.0.0:${port.listen}", "udp://0.0.0.0:${port.listen}"]`,
    `console_log_level = "warn"`,
    '',
    '[network_identity]',
    `network_name = "${RELAY_NET}"`,
    `network_secret = "${SECRET}"`,
    '',
    '[flags]',
    'no_tun = true',
    'multi_thread = true',
    'enable_encryption = true',
    `relay_network_whitelist = "mclink-room-*"`,
    'bind_device = false',
    'default_protocol = "tcp"',
    ...(latencyFirst ? ['latency_first = true'] : []),
    ...(marked ? ['disable_relay_data = true'] : []),
    '',
  ].join('\n');
}

function clientToml(name, ipv4, port, peers, latencyFirst) {
  const peerBlocks = peers
    .flatMap((p) => [`[[peer]]`, `uri = "tcp://127.0.0.1:${p.listen}"`, `[[peer]]`, `uri = "udp://127.0.0.1:${p.listen}"`])
    .join('\n');
  return [
    `instance_name = "${name}"`,
    `hostname = "${name}"`,
    `dhcp = false`,
    `ipv4 = "${ipv4}"`,
    `listeners = ["tcp://0.0.0.0:${port.listen}", "udp://0.0.0.0:${port.listen}"]`,
    `console_log_level = "warn"`,
    '',
    '[network_identity]',
    `network_name = "${ROOM_NET}"`,
    `network_secret = "${SECRET}"`,
    '',
    peerBlocks,
    '',
    '[flags]',
    'no_tun = true',
    'enable_encryption = true',
    'bind_device = false',
    // 两台客户端都在同一台机器上，直连是"必然成功"的 —— 关掉 p2p 才能逼出中继选路，
    // 也就是线上真正要考察的那一步（等价于我们客户端的「强制走中继」）。
    'disable_p2p = true',
    ...(latencyFirst ? ['latency_first = true'] : []),
    '',
  ].join('\n');
}

function start(name, configPath, rpcPort, logPath) {
  const child = spawn(CORE, ['-c', configPath, '-r', `127.0.0.1:${rpcPort}`, '--rpc-portal-whitelist', '127.0.0.1/32'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 打补丁的构建（deploy/easytier-patches/debug）会往 stderr 打 [mclink-probe] 探针
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on('error', (err) => console.error(`  [${name}] 启动失败：${err.message}`));
  return child;
}

/** 从日志里汇总 [mclink-probe] 探针（打过 debug 补丁的构建才有） */
function summarizeProbe(logPath, kind) {
  let text = '';
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n').filter((l) => l.includes('[mclink-probe]'));
  if (lines.length === 0) return null;
  const seen = new Set();
  for (const l of lines) {
    if (kind === 'publish') {
      const m = /publish self: (.*)$/.exec(l);
      if (m) seen.add(m[1].trim());
    } else {
      const m = /route read avoid_relay: (.*)$/.exec(l);
      if (m) seen.add(m[1].trim());
    }
  }
  const head = kind === 'publish' ? '发布' : '选路读到';
  return `${head}: ${[...seen].slice(0, 6).join(' | ')}${seen.size > 6 ? ` …(+${seen.size - 6})` : ''}`;
}

function cli(rpcPort, args) {
  return new Promise((resolve) => {
    const p = spawn(CLI, ['-p', `127.0.0.1:${rpcPort}`, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => resolve({ out, err }));
    setTimeout(() => p.kill(), 8000);
  });
}

async function jsonCli(rpcPort, args) {
  const { out } = await cli(rpcPort, ['-o', 'json', ...args]);
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

const results = [];
for (const c of cases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `et-repro-${c.name}-`));
  const peersOfClient = c.onlyMarked ? [P.relayA] : [P.relayA, P.relayB];
  const files = {
    relayA: path.join(dir, 'relayA.toml'),
    relayB: path.join(dir, 'relayB.toml'),
    client1: path.join(dir, 'client1.toml'),
    client2: path.join(dir, 'client2.toml'),
  };
  fs.writeFileSync(files.relayA, relayToml('relayA', P.relayA, c.marked, c.latencyFirst, c.members === true));
  fs.writeFileSync(files.relayB, relayToml('relayB', P.relayB, false, c.latencyFirst, c.members === true));
  fs.writeFileSync(files.client1, clientToml('client1', '10.199.0.1/24', P.client1, peersOfClient, c.latencyFirst));
  fs.writeFileSync(files.client2, clientToml('client2', '10.199.0.2/24', P.client2, peersOfClient, c.latencyFirst));

  const procs = [
    start('relayA', files.relayA, P.relayA.rpc, path.join(dir, 'relayA.log')),
    start('relayB', files.relayB, P.relayB.rpc, path.join(dir, 'relayB.log')),
    start('client1', files.client1, P.client1.rpc, path.join(dir, 'client1.log')),
    start('client2', files.client2, P.client2.rpc, path.join(dir, 'client2.log')),
  ];

  let row = null;
  try {
    // 等 client1 的路由表里出现 client2（最多 ~25 秒）
    for (let i = 0; i < 25; i += 1) {
      await sleep(1000);
      const table = await jsonCli(P.client1.rpc, ['route']);
      if (Array.isArray(table)) {
        const found = table.find((r) => r.hostname === 'client2');
        if (found) {
          row = found;
          if (i >= 6) break; // 再等几秒让选路收敛
        }
      }
    }
    const table = (await jsonCli(P.client1.rpc, ['route'])) ?? [];
    const found = Array.isArray(table) ? table.find((r) => r.hostname === 'client2') : null;
    if (found) row = found;
    const peers = (await jsonCli(P.client1.rpc, ['peer', 'list'])) ?? [];
    // 外来网络里的服务端会带 "PublicServer_" 前缀，所以用包含匹配
    const relayA = Array.isArray(peers) ? peers.find((p) => String(p.hostname ?? '').includes('relayA')) : null;
    const relayB = Array.isArray(peers) ? peers.find((p) => String(p.hostname ?? '').includes('relayB')) : null;
    results.push({
      case: c.name,
      expect: c.expect,
      nextHop: found?.next_hop_hostname ?? '(没找到 client2)',
      pathLen: found?.path_len ?? '-',
      pathLatency: found?.path_latency ?? '-',
      relayA: relayA ? `${relayA.cost}/${relayA.lat_ms}ms` : '(未连上)',
      relayB: relayB ? `${relayB.cost}/${relayB.lat_ms}ms` : '(未连上)',
      probePublish: c.keepLogs ? summarizeProbe(path.join(dir, 'relayA.log'), 'publish') : null,
      probeRead: c.keepLogs ? summarizeProbe(path.join(dir, 'client1.log'), 'read') : null,
      dir,
    });
  } finally {
    for (const p of procs) {
      try {
        p.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    await sleep(500);
    if (!KEEP) fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n用例'.padEnd(28) + '到 client2 的 next_hop'.padEnd(26) + '跳/延迟'.padEnd(12) + 'relayA'.padEnd(18) + 'relayB');
for (const r of results) {
  console.log(
    r.case.padEnd(26) + String(r.nextHop).padEnd(26) + `${r.pathLen}/${r.pathLatency}`.padEnd(12) +
      String(r.relayA).padEnd(18) + String(r.relayB),
  );
}

const markedCases = results.filter((r) => r.case.startsWith('marked-') && r.expect === 'relayB');
const broken = markedCases.filter((r) => String(r.nextHop).includes('relayA'));

// 探针汇总（只有打过 debug 补丁的构建才有输出）
const probed = results.filter((r) => r.probePublish || r.probeRead);
if (probed.length > 0) {
  console.log('探针（[mclink-probe]，来自打过 debug 补丁的构建）：');
  for (const r of probed) {
    console.log(`  · ${r.case}`);
    if (r.probePublish) console.log(`      relayA ${r.probePublish}`);
    if (r.probeRead) console.log(`      client1 ${r.probeRead}`);
  }
}
if (KEEP) {
  console.log('\n日志目录（--keep）：');
  for (const r of results) console.log(`  · ${r.case}: ${r.dir}`);
}

console.log('');
if (broken.length > 0) {
  console.log(`✗ 复现成功：${broken.map((r) => r.case).join('、')} 里 next_hop 仍然是被标记的 relayA`);
  process.exitCode = 1;
} else if (markedCases.length > 0) {
  console.log('✓ 未复现：被标记的 relayA 都被绕开了');
  process.exitCode = 0;
} else {
  console.log('（只跑了对照用例，不做判定）');
}
