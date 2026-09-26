#!/usr/bin/env node
/**
 * 开发期校验脚本：用**真实采集**的 easytier-cli 输出核对解析逻辑。
 *
 * 为什么需要它：连接诊断面板只有在本地 easytier-core 正常运行时才有真实数据，
 * 而开发机往往没有管理员权限（客户端起不来 TUN）。这个脚本把 vendor 里
 * easytier-cli 2.6.4 的真实输出当 fixture，离线验证
 * client/src/lib/easytier-parse.ts 的解析结果。
 *
 * 重新采集 fixture 的方法（主控中继在跑时）：
 *   vendor\easytier\easytier-cli.exe -p 127.0.0.1:15888 -o json node info
 *   vendor\easytier\easytier-cli.exe -p 127.0.0.1:15888 -o json peer list
 *
 * 用法：node client/scripts/verify-diagnostic.mjs
 */
import { extractNodeFacts, linkKind, listenPortsOf, parseLocalNatType, parseLossRate, parsePeers } from '../src/lib/easytier-parse.ts';

/* ------------------------------------------------ 真实 fixture（2.6.4） */

// 采集自 easytier-cli -p 127.0.0.1:15888 -o json node info（已裁掉 config 里的长 TOML）
const NODE_INFO = {
  peer_id: 25828045,
  ipv4_addr: '',
  proxy_cidrs: [],
  hostname: 'mclink-relay',
  stun_info: {
    udp_nat_type: 8,
    tcp_nat_type: 6,
    last_update_time: 1789987998,
    public_ip: ['120.38.30.197'],
    min_port: 8711,
    max_port: 8715,
  },
  inst_id: '1419b1a7-ff99-4793-b3fa-54f4679d7ae2',
  listeners: [
    'ring://1419b1a7-ff99-4793-b3fa-54f4679d7ae2',
    'tcp://0.0.0.0:11010',
    'udp://0.0.0.0:11010',
    'tcp://[::]:11010',
    'udp://[::]:11010',
  ],
  version: '2.6.4-8428a89d',
  ip_list: {
    public_ipv4: { addr: 2015764165 },
    interface_ipv4s: [{ addr: 3232236178 }, { addr: 2851998317 }],
    public_ipv6: null,
    interface_ipv6s: [{ part1: 4258961189 }],
  },
};

// 采集自 easytier-cli -p 127.0.0.1:15888 -o json peer list
const PEER_LIST = [
  {
    cidr: '',
    ipv4: '',
    hostname: 'mclink-relay',
    cost: 'Local',
    lat_ms: '-',
    loss_rate: '-',
    rx_bytes: '-',
    tx_bytes: '-',
    tunnel_proto: '-',
    nat_type: 'SymmetricEasyInc',
    id: '25828045',
    version: '2.6.4-8428a89d',
  },
  {
    cidr: '10.200.1.2/24',
    ipv4: '10.200.1.2',
    hostname: '玩家的台式机',
    cost: 'p2p',
    lat_ms: '17.33',
    loss_rate: '0',
    rx_bytes: '17.33 kB',
    tx_bytes: '1.02 MB',
    tunnel_proto: 'udp',
    nat_type: 'PortRestricted',
    id: '3184721904',
    version: '2.6.4-8428a89d',
  },
  {
    cidr: '10.200.1.3/24',
    ipv4: '10.200.1.3',
    hostname: 'relay-hop',
    cost: 'relay(1)',
    lat_ms: '88.5',
    loss_rate: '0',
    rx_bytes: '2.5 MiB',
    tx_bytes: '512 B',
    tunnel_proto: 'tcp',
    nat_type: '-',
    id: '9900112233',
    version: '2.6.4-8428a89d',
  },
  /*
   * 第三条：**劣化的直连**。loss_rate 这一列在 2.6.4 的真实 JSON 输出里是字符串，
   * 但格式没有稳定契约（人读的表格里带 `%`，上游也可能改回裸 f32），
   * 所以这里把三种写法都钉成 fixture —— 解析器必须全都认，且都不许抛异常。
   */
  {
    cidr: '10.200.1.4/24',
    ipv4: '10.200.1.4',
    hostname: '丢包的直连',
    cost: 'p2p',
    lat_ms: '23.4',
    loss_rate: '5.3%',
    rx_bytes: '480 kB',
    tx_bytes: '96 kB',
    tunnel_proto: 'udp',
    nat_type: '-',
    id: '1122334455',
    version: '2.6.4-8428a89d',
  },
];

/* ------------------------------------------------------------- 断言 */

let failed = 0;
const eq = (actual, expected, label) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`);
};

console.log('easytier-cli 输出解析校验（fixture 来自 easytier-cli 2.6.4 真实输出）\n== node info ==');
const facts = extractNodeFacts(NODE_INFO);
eq(facts.peerId, '25828045', 'peer_id 是数字，也能取到（转字符串）');
eq(facts.hostname, 'mclink-relay', 'hostname');
eq(facts.natUdp, 8, 'stun_info.udp_nat_type = 8');
eq(facts.natTcp, 6, 'stun_info.tcp_nat_type = 6');
eq(facts.publicIp, '120.38.30.197', 'stun_info.public_ip 是数组，取第一个');
eq(
  facts.listenUrls,
  ['ring://1419b1a7-ff99-4793-b3fa-54f4679d7ae2', 'tcp://0.0.0.0:11010', 'udp://0.0.0.0:11010', 'tcp://[::]:11010', 'udp://[::]:11010'],
  'listeners 全部取出（含 ring:// 与 IPv6）',
);
eq(facts.virtualIp, null, 'ipv4_addr 为空串 → null（界面显示「未分配」而不是空白）');
eq(listenPortsOf(facts.listenUrls), ['11010'], '从监听地址解析出端口（127.0.0.1:15888 的 ring 不误伤）');

console.log('\n== peer list ==');
const peers = parsePeers(PEER_LIST);
eq(peers.length, 3, '本机行（cost=Local 且无虚拟地址）被跳过，剩 3 个远端节点');
eq(peers[0]?.ipv4, '10.200.1.2', '第一个节点虚拟地址');
eq(peers[0]?.latencyMs, 17.33, 'lat_ms 字符串 → 数字');
eq(peers[0]?.rxBytes, 17330, 'rx_bytes "17.33 kB" → 17330 字节');
eq(peers[0]?.txBytes, 1020000, 'tx_bytes "1.02 MB" → 1020000 字节');
eq(peers[0]?.tunnelProto, 'udp', 'tunnel_proto');
eq(peers[0]?.natType, 'PortRestricted', 'nat_type 名字');
eq(peers[1]?.natType, '', 'nat_type "-" → 空串');
eq(linkKind('p2p'), 'p2p', 'linkKind: p2p → 直连');
eq(linkKind('relay(1)'), 'relay', 'linkKind: relay(1) → 经中继');
eq(linkKind('Local'), 'local', 'linkKind: Local → 本机');
eq(parseLocalNatType(PEER_LIST), 'SymmetricEasyInc', '本机 NAT 类型名取自 CLI 自己的输出（8 ↔ SymmetricEasyInc）');

console.log('\n== 丢包率（这一列格式不稳，必须容错） ==');
eq(peers[0]?.lossRate, 0, '"0" → 0（测得没丢包，与"没测到"是两件事）');
eq(peers[1]?.lossRate, 0, '中继行也有丢包读数');
eq(peers[2]?.lossRate, 0.053, '"5.3%"（人读表格的写法）→ 0.053');
eq(parseLossRate('0.053'), 0.053, '裸小数 → 按比例，原样');
eq(parseLossRate(0.08), 0.08, '裸 number 0.08 → 8%');
eq(parseLossRate('8'), 0.08, '裸数字 >1 → 只可能是百分数（丢包率不可能超过 100%）');
eq(parseLossRate('100%'), 1, '100% → 夹到 1');
eq(parseLossRate('120%'), 1, '超过 100% 的脏数据 → 夹到 1，不显示 120.0%');
eq(parseLossRate('-'), null, '"-"（未测得）→ null，界面显示 —');
eq(parseLossRate('*'), null, '"*" → null');
eq(parseLossRate(''), null, '空串 → null');
eq(parseLossRate(undefined), null, 'undefined → null（旧版本没有这一列）');
eq(parseLossRate(null), null, 'null → null');
eq(parseLossRate({}), null, '对象 → null（不抛异常）');
eq(parseLossRate('abc'), null, '认不出的字符串 → null（不抛异常）');
eq(parseLossRate(NaN), null, 'NaN → null');
eq(parseLossRate(-0.2), 0, '负数脏数据 → 夹到 0');

console.log(`\n结果：${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
if (failed > 0) process.exitCode = 1;
