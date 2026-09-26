#!/usr/bin/env node
/**
 * 开发期校验脚本：用**真实的 TCP 监听**核对中继延迟探测（tcping）的行为。
 *
 * 为什么需要它：`net:tcping` 只有在真机上连着中继才有数据，而这里要断言的四件事
 * （连通取到数 / 拒绝回 null / 黑洞不拖死 / 目标并行）都必须在真 socket 上才成立。
 * 于是本脚本自己起监听、自己制造失败，不依赖任何外部节点。
 *
 * 用法：node client/scripts/verify-tcping.mjs
 */
import net from 'node:net';
import { HOST_PATTERN, normalizeTargets, tcpHandshakeMs, tcpPingAll } from '../electron/tcping.cjs';

let failed = 0;

function check(ok, label, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : `\n      ${detail}`}`);
}

function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(ok, label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** 起一个真实监听：记录接受连接数，连上就断（中继端口对 tcping 而言就是这样） */
function listen() {
  return new Promise((resolve) => {
    const srv = net.createServer((socket) => {
      srv.seen += 1;
      socket.destroy();
    });
    srv.seen = 0;
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const close = (srv) => new Promise((resolve) => srv.close(resolve));

/* ------------------------------------------------------------ 真实连通 */
console.log('tcping 校验（真实 TCP 监听）\n== 连得上的目标 ==');
const alive = await listen();
const key = `127.0.0.1:${alive.port}`;

const hit = await tcpPingAll([{ host: '127.0.0.1', port: alive.port }]);
eq(Object.keys(hit), [key], '返回的键是 `host:port`');
check(Number.isInteger(hit[key]) && hit[key] >= 1, '本机监听：取到整数毫秒且下限为 1', `实际 ${JSON.stringify(hit[key])}`);
check(alive.srv.seen === 2, '默认采样 2 次 = 中继上看到 2 次「连上就断」（tcping 的固有代价）', `实际 ${alive.srv.seen} 次`);

// DNS 名也要能测：玩家看到的是域名，解析时间本来就该算进去
const byName = await tcpPingAll([{ host: 'localhost', port: alive.port }]);
check(Number.isInteger(byName[`localhost:${alive.port}`]), '主机名（走 DNS 解析）同样能测出延迟', JSON.stringify(byName));
check(byName[`localhost:${alive.port}`] >= 1 && byName[`localhost:${alive.port}`] < 1000, '本机域名解析 + 握手是毫秒级，不是秒级', `实际 ${byName[`localhost:${alive.port}`]}`);

// 单次握手：服务器不发任何字节也必须立刻返回（tcping 量的是握手，不是往返业务数据）
const one = await tcpHandshakeMs('127.0.0.1', alive.port);
check(typeof one === 'number' && one >= 0 && one < 100, '服务器只 accept 不写数据时也能立刻拿到握手耗时', `实际 ${one}`);

/* ------------------------------------------------------------ 连不上 = null */
console.log('\n== 连不上的目标（必须回 null，不能抛异常）==');
const dead = await listen();
const deadPort = dead.port;
await close(dead.srv); // 端口已经没人监听了 → ECONNREFUSED
const refused = await tcpPingAll([{ host: '127.0.0.1', port: deadPort }]);
eq(refused[`127.0.0.1:${deadPort}`], null, '端口没人监听（ECONNREFUSED）→ null');

const badDns = await tcpPingAll([{ host: 'no-such-relay.invalid', port: 11010 }]);
eq(badDns['no-such-relay.invalid:11010'], null, '域名解析不了 → null');

/**
 * TEST-NET-1（192.0.2.0/24）是**不可路由**的保留网段：要么超时，要么立刻 EHOSTUNREACH，
 * 两条路都必须收敛到 null，而且不能超过「单次超时 × 采样次数」这个上限。
 */
const blackholeStart = Date.now();
const blackhole = await tcpPingAll([{ host: '192.0.2.1', port: 11010 }], { timeoutMs: 300 });
const blackholeMs = Date.now() - blackholeStart;
eq(blackhole['192.0.2.1:11010'], null, '黑洞地址 → null');
check(blackholeMs < 1300, '黑洞不会拖死界面（2 次采样 × 300ms 超时 + 余量）', `实际 ${blackholeMs}ms`);

/* ------------------------------------------------------------ 目标并行 */
console.log('\n== 目标之间并行（界面只等最慢的那一个）==');
const parallelStart = Date.now();
const parallel = await tcpPingAll(
  [
    { host: '192.0.2.1', port: 11010 },
    { host: '192.0.2.2', port: 11010 },
    { host: '192.0.2.3', port: 11010 },
    { host: '192.0.2.4', port: 11010 },
  ],
  { timeoutMs: 300 },
);
const parallelMs = Date.now() - parallelStart;
eq(Object.keys(parallel).length, 4, '4 个目标都给出了结果');
check(parallelMs < 1300, '4 个黑洞目标并行探测，总耗时 ≈ 1 个（不是 4 个相加）', `实际 ${parallelMs}ms`);

/* ------------------------------------------------------------ 入参防线 */
console.log('\n== 入参过滤（渲染进程给什么都不能让主进程炸）==');
eq(normalizeTargets(null), [], '非数组 → 空');
eq(normalizeTargets('127.0.0.1'), [], '字符串 → 空');
eq(normalizeTargets([null, 42, 'x', {}]), [], '垃圾元素 → 全部丢掉');
eq(
  normalizeTargets([
    { host: 'a b', port: 11010 },
    { host: 'x', port: 0 },
    { host: 'x', port: 70000 },
    { host: 'x', port: 1.5 },
    { host: 'x:y', port: 1 },
    { host: '', port: 1 },
  ]),
  [],
  '非法主机名/端口（含带冒号的主机）一律拒绝',
);
eq(normalizeTargets([{ host: '  relay.example.com  ', port: '21010' }]), [{ host: 'relay.example.com', port: 21010 }], '两端空白去掉；端口字符串转数字');
eq(
  normalizeTargets([
    { host: 'relay.example.com', port: 21010 },
    { host: 'relay.example.com', port: 21010 },
    { host: 'relay.example.com', port: 11010 },
  ]).length,
  2,
  '同一个 host:port 去重，同主机不同端口各算一个',
);
check(!HOST_PATTERN.test('relay:21010'), '主机字段不接受冒号（否则 `host:port` 这个键会有歧义）');

const empty = await tcpPingAll([]);
eq(empty, {}, '空列表 → 空对象（界面留空显示 —）');
eq(await tcpPingAll(undefined), {}, 'undefined → 空对象，不抛异常');

/* ------------------------------------------------------------ 采样取最小值 */
console.log('\n== 多次采样取最小值 ==');
const sampled = await tcpPingAll([{ host: '127.0.0.1', port: alive.port }], { attempts: 3 });
check(Number.isInteger(sampled[key]), '采样 3 次仍然给出一个数', JSON.stringify(sampled));

await close(alive.srv);

console.log(`\n结果：${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
if (failed > 0) process.exitCode = 1;
