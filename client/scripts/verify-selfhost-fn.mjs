#!/usr/bin/env node
/**
 * 功能校验：真的把 `withExtraPeers` / `normalizePeerUri` 跑一遍（不是看源码里有没有那行）。
 *
 * 源码断言（`client/scripts/verify-selfhost.mjs`）只能证明"规则还在"，
 * 证明不了"拼出来的配置内核能读"。这个脚本直接 import 那两个纯函数模块，
 * 用一张**真实形状的票据 TOML** 走一遍，打印注入结果并断言位置与去重。
 *
 * 用法：node client/scripts/verify-selfhost-fn.mjs
 */
import { normalizeMasterUrl } from '../src/lib/master-url.ts';
import { normalizePeerUri, splitPeerUris, withExtraPeers, withDisableP2p } from '../src/lib/relay-fallback.ts';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`);
};
const eq = (name, actual, expected) =>
  check(name, actual === expected, actual === expected ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

/* ---------------------------------------------------------------- 主控地址 */

console.log('主控地址归一化');
eq('https 原样（去尾斜杠）', normalizeMasterUrl('https://mclink.example.com/'), 'https://mclink.example.com');
eq('没写协议补 http', normalizeMasterUrl('192.168.1.10:8787'), 'http://192.168.1.10:8787');
eq('带路径只留 origin', normalizeMasterUrl('https://example.com/console/rooms'), 'https://example.com');
eq('带端口保留端口', normalizeMasterUrl('http://example.com:8787/api'), 'http://example.com:8787');
eq('空串 = 没有覆盖', normalizeMasterUrl('   '), null);
eq('非 http 协议拒绝', normalizeMasterUrl('file:///etc/passwd'), null);
eq('乱码拒绝', normalizeMasterUrl('这不是地址'), null);

/* ---------------------------------------------------------------- 节点地址 */

console.log('\n节点地址解析');
eq('tcp 原样', normalizePeerUri('tcp://relay.example.com:11010'), 'tcp://relay.example.com:11010');
eq('udp 原样', normalizePeerUri('udp://relay.example.com:11010'), 'udp://relay.example.com:11010');
eq('裸主机补默认端口', normalizePeerUri('relay.example.com'), 'tcp://relay.example.com:11010');
eq('带路径的网页地址拒绝', normalizePeerUri('https://info.qtet.cn/uptime/easytier'), null);
eq('端口越界拒绝', normalizePeerUri('tcp://relay.example.com:99999'), null);
// 三个地址，每个都没写协议 → tcp + udp 各一条 = 6（全角逗号/分号也是分隔符）
eq('空格/中文逗号/全角分号都当分隔符', splitPeerUris('a.com:11010, b.com:11010；c.com').length, 6);
// 端口必须是纯数字：`b.com:11010；c.com` 那种"粘在一起"的输入不该被截断成一条合法地址
eq('端口里混了别的东西 → 整条拒绝', normalizePeerUri('b.com:11010x'), null);
eq('空文本没有地址', splitPeerUris('   ,  ; ').length, 0);

/* ---------------------------------------------------------- 注入票据 TOML */

const ticket = [
  '[network_identity]',
  'network_name = "mclink-room-abc"',
  'network_secret = "0123456789abcdef"',
  '',
  '[[peer]]',
  'uri = "tcp://relay.official.example:11010"',
  '[[peer]]',
  'uri = "udp://relay.official.example:11010"',
  '',
  '[flags]',
  'disable_p2p = false',
  'relay_network_whitelist = "*"',
  '',
].join('\n');

console.log('\n注入 [[peer]]');
const injected = withExtraPeers(ticket, splitPeerUris('public.easytier.cn:11010, tcp://relay.official.example:11010'));
const lines = injected.split('\n');
const peerIdx = lines.map((l, i) => (/^\s*\[\[peer\]\]\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
check('新增了 2 个 [[peer]]（tcp+udp 各一条）', peerIdx.length === 4, `实际 ${peerIdx.length} 个 peer 段`);
check(
  '插在原有 peer 之后、[flags] 之前',
  peerIdx.every((i) => i < lines.findIndex((l) => /^\s*\[flags\]/.test(l))),
  `最后一段 [flags] 在第 ${lines.findIndex((l) => /^\s*\[flags\]/.test(l)) + 1} 行`,
);
check('平台已给的地址不重复写', injected.split('tcp://relay.official.example:11010').length - 1 === 1);
check('新地址两条都在', injected.includes('uri = "tcp://public.easytier.cn:11010"') && injected.includes('uri = "udp://public.easytier.cn:11010"'));
check('原有内容一字未动（network_secret 还在）', injected.includes('network_secret = "0123456789abcdef"'));
check('非法地址被跳过而不是抛错', withExtraPeers(ticket, ['https://info.qtet.cn/uptime/easytier']).split('[[peer]]').length === 3);

console.log('\n与"强制走中继"叠加');
const both = withDisableP2p(withExtraPeers(ticket, ['public.easytier.cn:11010']));
check('disable_p2p 被翻转成 true', /disable_p2p = true/.test(both));
check('追加的 peer 仍然在', both.includes('tcp://public.easytier.cn:11010'));
check('没有 [flags] 段时也能注入', withDisableP2p('[network_identity]\nnetwork_name = "x"\n').includes('[flags]'));

/* ------------------------------------------------------------------ 打印 */

console.log('\n--- 注入后的配置（人工过目用）---');
console.log(injected);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
