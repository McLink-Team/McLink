#!/usr/bin/env node
/**
 * 开发期校验脚本：「到房主的直连丢包 → 回落中继」的**纯逻辑**部分。
 *
 * 为什么需要它：这一段的三个动作都会**重启 easytier-core 并断流几秒**，
 * 靠真机手工点是验不全的（真机上网络太好，构造不出 5% 丢包；CDP 里也很难
 * 等满 36 秒 × 多个窗口）。所以把"什么条件下动手、动完怎么判断"抽成纯函数
 * （client/src/lib/relay-fallback.ts），在这里用构造数据把它们逐条钉死；
 * 真机那一侧只验"开关真的重启了核心 + 状态能持久化"（见 .cache/verify-relay-ui.mjs）。
 *
 * 判据的对象在这一版被纠正过：`cost = p2p` 只说明**本机到那个节点**是直连，
 * 不是"玩家之间的 P2P"（本机到平台中继节点往往也是直连）。所以下面每一条用例
 * 都围绕**房主那条链路**：别的节点丢多少都不进结论。
 *
 * 用法：node client/scripts/verify-relay-fallback.mjs
 */
import {
  AB_LATENCY_ABS_MS,
  LOSS_THRESHOLD,
  PROBE_BASE_MS,
  PROBE_MAX_MS,
  bestRoutes,
  formatLoss,
  hostLinkQuality,
  hostRoute,
  nextProbeDelay,
  relayLooksWorse,
  withDisableP2p,
} from '../src/lib/relay-fallback.ts';

let failed = 0;
const eq = (actual, expected, label) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(
    `${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`,
  );
};
const ok = (cond, label) => eq(Boolean(cond), true, label);

/** 造一个 peer list 行；只有测试关心的字段 */
const peer = (ipv4, cost, loss, lat = 10, rx = 1024) => ({
  hostname: ipv4,
  ipv4,
  cost,
  latencyMs: lat,
  lossRate: loss,
  rxBytes: rx,
  txBytes: 0,
  tunnelProto: 'udp',
  natType: '',
});

/* ------------------------------------------------- 主控下发的票据 TOML（真实形态）
 * 结构照抄 server/src/easytier/config.ts 的 renderEasytierToml：
 * `[flags]` 段在 `[[peer]]` 之后、`[file_logger]` / `[acl...]` 之前。 */
const TICKET_TOML = [
  '# 由 mclink 主控自动生成，请勿手工编辑 —— 下次同步会被覆盖',
  'instance_name = "mclink-room-ABC123"',
  'hostname = "玩家的台式机"',
  'ipv4 = "10.200.1.2/24"',
  'listeners = ["tcp://0.0.0.0:11010", "udp://0.0.0.0:11010"]',
  '',
  '[network_identity]',
  'network_name = "mclink-room-ABC123"',
  'network_secret = "s3cr3t"',
  '',
  '[[peer]]',
  'uri = "tcp://relay.example:11010"',
  '',
  '[flags]',
  'bind_device = false',
  'dev_name = "McLink"',
  'enable_udp_broadcast_relay = false',
  'disable_p2p = false',
  '',
  '[file_logger]',
  'level = "info"',
  'file = "F:/logs/easytier"',
  '',
  '[acl.acl_v1]',
  'name = "mclink"',
].join('\n');

console.log('票据 TOML 注入 disable_p2p\n== [flags] 已存在 ==');
{
  const out = withDisableP2p(TICKET_TOML);
  const flags = out.split('[flags]\n')[1].split('\n[')[0];
  ok(/^disable_p2p = true$/m.test(flags), 'disable_p2p 被翻成 true');
  ok(!/disable_p2p = false/.test(out), '没有残留 disable_p2p = false');
  eq(out.split('\n').length, TICKET_TOML.split('\n').length, '只换值不增减行数（没有多插一行）');
  eq(out.split('disable_p2p').length - 1, 1, '整个文件里只有一处 disable_p2p（没在别处复制一份）');
  eq((out.match(/^\[flags\]$/gm) ?? []).length, 1, '只有一个 [flags] 段');
  // 关键：注入不能把后面的段"吞"进 [flags]
  const tail = out.slice(out.indexOf('[file_logger]'));
  ok(tail.startsWith('[file_logger]'), '[file_logger] 及其后的段没被改动');
  eq(out.split('[acl.acl_v1]')[1], TICKET_TOML.split('[acl.acl_v1]')[1], '[acl] 段逐字未动');
  eq(withDisableP2p(out), out, '幂等：对已注入的 TOML 再注入一次结果不变（重进房间会再走一遍）');
}

console.log('\n== [flags] 不存在（旧版本 / 手工配置） ==');
{
  const bare = 'instance_name = "x"\n\n[network_identity]\nnetwork_name = "n"\nnetwork_secret = "s"\n';
  const out = withDisableP2p(bare);
  ok(out.includes('\n[flags]\ndisable_p2p = true\n'), '在文件末尾补出 [flags] 段并写入');
  // 追加在末尾是关键：TOML 里表头之后的裸键都属于它，插在中间会把别人的键抢过来
  ok(out.indexOf('[flags]') > out.indexOf('network_secret'), '[flags] 追加在所有既有段之后');
  eq(out.slice(0, bare.length), bare, '原有内容逐字未动');
  eq(withDisableP2p(out), out, '幂等');
}

console.log('\n== 房主已经关掉 P2P（disable_p2p = true 本来就在） ==');
{
  const already = 'x = 1\n\n[flags]\ndisable_p2p = true\n';
  const out = withDisableP2p(already);
  eq(out, already, '原样返回（不会写第二行，也不会重复段头）');
}

/* ------------------------------------------------------------------ 采样与判据 */

/*
 * 判据的对象是**「本机 → 房主」那一条链路**（hostLinkQuality）。
 *
 * 这里钉死的正是用户实测抓到的那次误报：`cost = p2p` 只说明**本机到那个节点**
 * 是直连，而本机到平台中继节点往往也是直连 —— 按 `cost` 判定会在
 * "房间里四条连接全是中继节点"时报出「P2P 直连在丢包」，而那条 8% 其实来自中继。
 */
const HOST = '10.200.7.2';

console.log('\n== 「到房主」质量判据（唯一判据） ==');
{
  /* 规则 3 + 用户截图场景：房间里的四条连接全是平台中继节点，
   * 其中 relay-sh 那条从本机看恰好是直连（cost=p2p）且丢 8% —— 上一版就是它触发的误报。
   * 中继节点在 peer list 里没有虚拟地址（ipv4 为空），归并键退回主机名。 */
  const relayPeer = (name, cost, loss) => ({ ...peer('', cost, loss), hostname: name });
  const relayRoom = [
    relayPeer('PublicServer_relay-sh', 'p2p', 0.08),
    relayPeer('PublicServer_阿里云上海', 'relay(1)', 0),
    relayPeer('广州腾讯云', 'relay(1)', 0),
    relayPeer('德国9929', 'p2p', 0.02),
  ];
  eq(
    hostLinkQuality(relayRoom, HOST),
    { hostIp: HOST, route: null, direct: false, lossRate: null, over: false },
    '【用户截图场景】全是中继节点、其中一条 cost=p2p 且丢 8% → 不是"到房主的直连"，判据为空、不提示',
  );

  eq(hostLinkQuality([], HOST).lossRate, null, '没有 peer → 没有可判断的对象');

  /* 规则 1：只有房主那条算数 —— 别的直连节点丢多少都不进来 */
  eq(
    hostLinkQuality([peer('10.200.7.9', 'p2p', 0.5)], HOST),
    { hostIp: HOST, route: null, direct: false, lossRate: null, over: false },
    '别的成员直连丢 50% → 不进判据（判据只看房主那条）',
  );

  /* 真正该提示/触发的那一种 */
  const bad = hostLinkQuality([peer(HOST, 'p2p', 0.08, 23)], HOST);
  eq(bad.lossRate, 0.08, '到房主是直连、丢 8% → 判据 0.08（这才是该提示的场景）');
  eq(bad.over, true, '＞5% → over（提示与自动回落都由它驱动）');
  eq(
    hostLinkQuality([peer(HOST, 'p2p', LOSS_THRESHOLD)], HOST).over,
    false,
    '正好等于 5% 不算超（用的是 > 而不是 ≥，阈值线上不动作）',
  );
  eq(hostLinkQuality([peer(HOST, 'p2p', 0.0)], HOST).over, false, '到房主直连不丢包 → 不触发');
  eq(
    hostLinkQuality([peer(HOST, 'p2p', null)], HOST).lossRate,
    null,
    '到房主直连但读数还没测出来 → 不拿未知当证据（这一窗作废）',
  );

  /* 规则 2：本机就是房主 */
  eq(
    hostLinkQuality([peer(HOST, 'p2p', 0.08), peer('10.200.7.3', 'p2p', 0.4)], HOST, true),
    { hostIp: HOST, route: null, direct: false, lossRate: null, over: false },
    '本机是房主：即使 peer list 里有同地址的行、别的直连丢 40%，也一律不判定（永不触发）',
  );

  /* 规则 4：非房主，但到房主走中继 */
  const viaRelay = hostLinkQuality([peer(HOST, 'relay(1)', 0.3)], HOST);
  eq(viaRelay.direct, false, '到房主走中继 → 不是直连');
  eq(viaRelay.lossRate, null, '中继丢 30% 也不判定（他已经在走中继，"强制走中继"毫无意义）');
  eq(viaRelay.over, false, '走中继 → 不触发自动回落');
  eq(viaRelay.route?.lossRate, 0.3, '但那条链路的读数仍然取得到（界面要如实显示中继自己的丢包）');

  eq(hostLinkQuality([peer(HOST, 'p2p', 0.09, 5), peer(HOST, 'relay(1)', 0.0, 40)], HOST).lossRate, 0.09, '同一房主同时有 p2p 与 relay 两条记录 → 归并取直连那条');

  /* 地址形态：本机那些带 /24，peer 行有时也带，必须都能对上 */
  eq(hostRoute([peer(`${HOST}/24`, 'p2p', 0.08)], HOST)?.key, `${HOST}/24`, 'peer 行带掩码 → 仍能匹配到房主');
  eq(hostRoute([peer(HOST, 'p2p', 0.08)], `${HOST}/24`)?.key, HOST, '房主地址带掩码（票据形态）→ 仍能匹配');
  eq(hostRoute([peer(HOST, 'p2p', 0.08)], ''), null, '拿不到房主地址（不在房间/旧票据）→ 不猜，判据为空');
  eq(hostRoute([peer(HOST, 'Local', 0.08)], HOST), null, '本机那一行（cost=Local）不参与匹配');
}

console.log('\n== 按节点归并路径 ==');
{
  const merged = bestRoutes([
    peer('10.0.0.2', 'relay(1)', 0.0, 40),
    peer('10.0.0.2', 'p2p', 0.02, 18),
    peer('10.0.0.3', 'relay(1)', 0.0, 55),
  ]);
  eq(merged.length, 2, '两个节点 → 两条记录');
  eq(merged.find((r) => r.key === '10.0.0.2')?.cost, 'p2p', 'p2p 优先于中继');
  eq(merged.find((r) => r.key === '10.0.0.3')?.cost, 'relay(1)', '只有中继的节点保留中继');
}

console.log('\n== A/B 对照：切到中继之后要不要切回去 ==');
{
  /* 自动回落的基线现在**只有房主那一条**（store 里用 hostRoute 取），
   * 所以 A/B 天然落在"我到房主：直连 vs 中继"上。 */
  const baseline = [hostRoute([peer(HOST, 'p2p', 0.08, 20)], HOST)];
  eq(baseline.length, 1, '基线就是到房主那一条链路');

  eq(
    relayLooksWorse(baseline, bestRoutes([peer(HOST, 'relay(1)', 0.0, 35)])),
    false,
    '中继不丢包、延迟 +15ms → 中继更好，保持（这是这个功能想要的正常结局）',
  );
  eq(
    relayLooksWorse(baseline, bestRoutes([peer(HOST, 'relay(1)', 0.03, 24)])),
    true,
    '中继自己也在丢 3% → 问题不在到房主那段直连，回退',
  );
  eq(
    relayLooksWorse(baseline, bestRoutes([peer(HOST, 'relay(1)', 0.0, 60)])),
    true,
    `中继延迟 60ms vs 直连 20ms（差 ${AB_LATENCY_ABS_MS}ms 以上且 >1.6 倍）→ 绕远，回退`,
  );
  eq(
    relayLooksWorse([hostRoute([peer(HOST, 'p2p', 0.08, 5)], HOST)], bestRoutes([peer(HOST, 'relay(1)', 0.0, 8)])),
    false,
    'P2P 基线只有 5ms 时，中继 8ms（1.6 倍）但只差 3ms → 不判更差（否则自动回落永远被立刻回退）',
  );
  eq(
    relayLooksWorse(baseline, bestRoutes([peer('10.0.0.9', 'relay(1)', 0.5, 200)])),
    false,
    '换了个人（不同虚拟地址）不参与对照：不同城市的延迟没有可比性',
  );
  eq(relayLooksWorse(baseline, []), false, '中继侧还没有样本 → 不下结论，保持现状');
  eq(
    relayLooksWorse(baseline, bestRoutes([peer(HOST, 'p2p', 0.08, 20)])),
    false,
    '还没切过去（仍是 p2p）→ 不算 A/B 结论',
  );
  eq(relayLooksWorse([], bestRoutes([peer(HOST, 'relay(1)', 0.05, 200)])), false, '基线上没有房主那条（例如本机是房主）→ 没有结论可下');
}

console.log('\n== 指数退避 ==');
{
  const p1 = nextProbeDelay(PROBE_BASE_MS);
  eq(p1, 30 * 60_000, '15 分钟 → 30 分钟');
  const p2 = nextProbeDelay(p1);
  eq(p2, PROBE_MAX_MS, '30 分钟 → 60 分钟');
  eq(nextProbeDelay(p2), PROBE_MAX_MS, '60 分钟封顶（不再翻倍）');
  eq(nextProbeDelay(1000), PROBE_BASE_MS, '小于基准的脏值 → 拉回基准，不会变成"每秒重试一次"');
}

console.log('\n== 显示格式 ==');
{
  eq(formatLoss(0.053), '5.3%', '0.053 → 5.3%');
  eq(formatLoss(0), '0.0%', '测得没丢包 → 0.0%');
  eq(formatLoss(null), '—', '没测到 → —（不是 0.0%，两者含义不同）');
  eq(formatLoss(0.1234), '12.3%', '保留一位小数');
  eq(formatLoss(1), '100.0%', '满分也是满分');
}

console.log(`\n结果：${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
if (failed > 0) process.exitCode = 1;
