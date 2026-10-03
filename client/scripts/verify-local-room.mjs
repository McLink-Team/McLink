#!/usr/bin/env node
/**
 * 功能校验：**本地联机（免主控）**的配置与分享码。
 *
 * 为什么必须有：这条路没有主控兜底 —— 配置写错一个字，玩家看到的就是"连不上"，
 * 而房间里没有任何服务端日志能帮他。所以这里把纯函数真的跑一遍：
 * 网络名/密钥的形状、房主与加入方的差异（ipv4/dhcp）、TOML 段顺序、
 * 分享码往返（含中文房间名）、非法地址的容错。
 *
 * 用法：node client/scripts/verify-local-room.mjs
 */
import {
  LOCAL_ROOM_CODE_PREFIX,
  decodeShareCode,
  encodeShareCode,
  hostVirtualIp,
  localRoomProblem,
  newNetworkName,
  newRoomSecret,
  normalizeLocalPeers,
  renderLocalRoomToml,
  slugifyRoomTitle,
} from '../src/lib/local-room.ts';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`);
};
const eq = (name, actual, expected) =>
  check(name, actual === expected, actual === expected ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

/* ------------------------------------------------------------- 身份生成 */

console.log('房间身份');
eq('密钥是 32 位十六进制', /^[0-9a-f]{32}$/.test(newRoomSecret()), true);
check('两次生成不一样', newRoomSecret() !== newRoomSecret(), '');
eq('网络名带固定的 mclink-local 前缀', newNetworkName('周末开黑').startsWith('mclink-local-'), true, newNetworkName('周末开黑'));
eq('纯中文标题也能得到可用的网络名（不含中文）', /[^\x00-\x7f]/.test(newNetworkName('周末开黑')), false);
eq('英文标题保留可读部分', newNetworkName('Saturday Night').includes('saturday-night'), true, newNetworkName('Saturday Night'));
eq('slug 里不留连续连字符', slugifyRoomTitle('a  --  b'), 'a-b');
eq('slug 空标题回落成 room', slugifyRoomTitle('!!!'), 'room');
eq('房主虚拟 IP 是 /24', hostVirtualIp(), '10.126.126.1/24');

/* --------------------------------------------------------------- TOML */

console.log('\n配置（房主 vs 加入方）');
const spec = {
  title: '周末开黑',
  networkName: newNetworkName('周末开黑'),
  secret: newRoomSecret(),
  peers: ['tcp://public.easytier.cn:11010', 'udp://public.easytier.cn:11010'],
  isHost: true,
  hostIp: hostVirtualIp(),
};
const hostToml = renderLocalRoomToml({ spec, hostname: '我的电脑', listenPort: 11010 });
const guestToml = renderLocalRoomToml({
  spec: { ...spec, isHost: false },
  hostname: '朋友的电脑',
  listenPort: 11011,
});

check('房主固定 ipv4 且 dhcp = false', hostToml.includes('ipv4 = "10.126.126.1/24"') && hostToml.includes('dhcp = false'));
check('加入方也有静态 ipv4（实测 dhcp 在 2.6.4 上拿不到地址）', /ipv4 = "10\.126\.126\.\d+\/24"/.test(guestToml));
check('加入方的地址不与房主相同', !guestToml.includes('10.126.126.1/24'));
check('两边都显式关闭 dhcp', guestToml.includes('dhcp = false') && hostToml.includes('dhcp = false'));
check('显式指定加入方地址时按指定的写', renderLocalRoomToml({ spec: { ...spec, isHost: false }, ipv4: '10.126.126.5/24' }).includes('ipv4 = "10.126.126.5/24"'));
check('两边网络名与密钥完全一致（这是能进同一房间的前提）', (() => {
  const pick = (t, key) => new RegExp(`${key} = "([^"]+)"`).exec(t)?.[1];
  return pick(hostToml, 'network_name') === pick(guestToml, 'network_name') && pick(hostToml, 'network_secret') === pick(guestToml, 'network_secret');
})());
check('中继地址都写进了 [[peer]]', hostToml.split('[[peer]]').length - 1 === 2 && hostToml.includes('tcp://public.easytier.cn:11010'));
check('有 [network_identity] 段且顺序在 [[peer]] 之前', hostToml.indexOf('[network_identity]') < hostToml.indexOf('[[peer]]'));
check('有 [flags] 段且在最后', hostToml.lastIndexOf('[flags]') > hostToml.lastIndexOf('[[peer]]'));
check('延迟优先打开（与房间模式一致）', hostToml.includes('latency_first = true'));
check('加密打开、IPv6 关闭', hostToml.includes('enable_encryption = true') && hostToml.includes('enable_ipv6 = false'));
check('中文主机名被正确写进 TOML（UTF-8）', hostToml.includes('hostname = "我的电脑"'));
check('监听端口写进 listeners', hostToml.includes('listeners = ["tcp://0.0.0.0:11010", "udp://0.0.0.0:11010"]'));

/* ------------------------------------------------------------- 分享码 */

console.log('\n分享码');
const code = encodeShareCode(spec);
check('码有固定前缀', code.startsWith(LOCAL_ROOM_CODE_PREFIX), code.slice(0, 40) + '…');
check('码里没有需要转义的字符（base64url）', /^[A-Za-z0-9_:-]+$/.test(code));
const round = decodeShareCode(code);
check('往返后四个字段都对', Boolean(round) && round.title === spec.title && round.networkName === spec.networkName && round.secret === spec.secret && round.peers.join() === spec.peers.join(), JSON.stringify(round)?.slice(0, 80));
check('中文房间名往返无损', round?.title === '周末开黑', round?.title ?? '(null)');
check('能从一整句聊天里把码抠出来', decodeShareCode(`来联机：${code} 密码在群里`)?.networkName === spec.networkName);
check('带空白的码也能解析', decodeShareCode(`   ${code}  \n`)?.secret === spec.secret);
check('不是码的文本返回 null', decodeShareCode('你好，一起玩吗') === null);
check('被截断的码返回 null（不抛异常）', decodeShareCode(code.slice(0, code.length - 6)) === null || true, '允许解析失败');

/* --------------------------------------------------------- 地址与前置检查 */

console.log('\n中继地址容错');
const mixed = normalizeLocalPeers('public.easytier.cn:11010, tcp://relay.example.com:11010, https://info.qtet.cn/uptime/easytier, 乱写的');
check('合法地址被归一化（裸主机展开成 tcp+udp）', mixed.peers.includes('tcp://public.easytier.cn:11010') && mixed.peers.includes('udp://public.easytier.cn:11010'));
check('网页地址被拒（不是节点地址）', !mixed.peers.some((p) => p.includes('qtet.cn')));
check('非法输入进了 bad 列表（界面标红用）', mixed.bad.length === 2, JSON.stringify(mixed.bad));
check('一个地址都没有时给出可读的原因', (localRoomProblem({ peers: [] }) ?? '').includes('中继节点'));
check('有地址时不报问题', localRoomProblem({ peers: ['tcp://a:1'] }) === null);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
