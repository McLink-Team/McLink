#!/usr/bin/env node
/**
 * 房间页「中继节点」角色判定的回归脚本（纯逻辑，不需要 Electron / 网络）。
 *
 * 为什么值得单独一个脚本：这条判据被一个真实的显示 bug 咬过 ——
 * EasyTier 把中继节点当"公共服务器"报给客户端，hostname 带 `PublicServer_` 前缀
 * （upstream `easytier/src/peers/mod.rs` 的 `PUBLIC_SERVER_HOSTNAME_PREFIX`），
 * 而票据 label 是平台下发的节点名（没有前缀）。当时判据没剥前缀 → 一个都对不上 →
 * 两行一起落到兜底分支 → 用户实测「都只显示是打洞节点」。
 *
 * 用法：node client/scripts/verify-relay-roles.mjs
 */
import assert from 'node:assert/strict';
import { relayNameKey, relayRoleOf, PUBLIC_SERVER_PREFIX } from '../src/lib/relay-roles.ts';
import { relayHintCopy } from '../src/lib/relay-hint.ts';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('▸ 名字归一化');
check('前缀常量与 upstream 一致', () => {
  assert.equal(PUBLIC_SERVER_PREFIX, 'PublicServer_');
});
check('剥掉 PublicServer_ 前缀、去空白、忽略大小写', () => {
  assert.equal(relayNameKey('PublicServer_阿里云上海'), relayNameKey('阿里云上海'));
  assert.equal(relayNameKey('  PUBLICserver_常山移动 '), relayNameKey('常山移动'));
  assert.equal(relayNameKey('public_server_常山移动'), relayNameKey('常山移动'));
  assert.equal(relayNameKey('publicserver_常山移动'), relayNameKey('常山移动'));
});
check('空白 / 分隔符 / 全角括号统一（名字两侧来源不同，容错要够）', () => {
  assert.equal(relayNameKey('阿里云 上海'), relayNameKey('阿里云-上海'));
  assert.equal(relayNameKey('阿里云-上海'), relayNameKey('阿里云_上海'));
  assert.equal(relayNameKey('阿里云（上海）'), relayNameKey('阿里云(上海)'));
  assert.equal(relayNameKey('华东 · 阿里云'), relayNameKey('华东阿里云'));
});
check('没有前缀的名字不动（前缀只在开头剥一次）', () => {
  assert.equal(relayNameKey('阿里云上海'), '阿里云上海');
  assert.equal(relayNameKey('常山_PublicServer_移动'), '常山publicserver移动');
});

console.log('\n▸ 角色判定（中继集合模型：命中即中继）');
const names = { allLabels: ['阿里云上海', '常山移动'] };
check('带前缀的两行都判成中继（中继集合模型：没有"打洞节点"角色）', () => {
  assert.equal(relayRoleOf(`${PUBLIC_SERVER_PREFIX}阿里云上海`, names), 'relay');
  assert.equal(relayRoleOf(`${PUBLIC_SERVER_PREFIX}常山移动`, names), 'relay');
});
check('两行都认得出来（都是我们的中继）', () => {
  const roles = [`${PUBLIC_SERVER_PREFIX}阿里云上海`, `${PUBLIC_SERVER_PREFIX}常山移动`].map((h) =>
    relayRoleOf(h, names),
  );
  assert.deepEqual(roles, ['relay', 'relay'], `实际 ${JSON.stringify(roles)}`);
});
check('不带前缀的内核 hostname 也能对上', () => {
  assert.equal(relayRoleOf('阿里云上海', names), 'relay');
  assert.equal(relayRoleOf('常山移动', names), 'relay');
});
check('只有一台中继时那台就是打洞槽', () => {
  assert.equal(relayRoleOf(`${PUBLIC_SERVER_PREFIX}阿里云上海`, { allLabels: ['阿里云上海'] }), 'relay');
});

console.log('\n▸ 认不出来时宁可不标');
check('不在票据里的 peer（别的房间 / 陌生节点）→ null', () => {
  assert.equal(relayRoleOf('北京的某台机器', names), null);
  assert.equal(relayRoleOf(`${PUBLIC_SERVER_PREFIX}北京的某台机器`, names), null);
});
check('空 hostname / 空票据 → null', () => {
  assert.equal(relayRoleOf('', names), null);
  assert.equal(relayRoleOf('   ', names), null);
  assert.equal(relayRoleOf('阿里云上海', { allLabels: [] }), null);
});
check('单台中继的票据也必须认得出来（不再依赖 punchLabel）', () => {
  assert.equal(relayRoleOf('阿里云上海', { allLabels: ['阿里云上海'] }), 'relay');
});

console.log('\n▸ 名字被截断 / 加了别的前后缀时的兜底（互相包含）');
check('内核名字多了后缀也能认出', () => {
  assert.equal(relayRoleOf('PublicServer_阿里云上海_200M', names), 'relay');
  assert.equal(relayRoleOf('PublicServer_常山移动(联通)', names), 'relay');
});
check('长名字优先：同时匹配到短标签时选最像的那个', () => {
  const two = { allLabels: ['上海', '阿里云上海'] };
  // `PublicServer_阿里云上海` 同时包含 `上海` 与 `阿里云上海` → 应选后者（= 中继槽）
  assert.equal(relayRoleOf('PublicServer_阿里云上海', two), 'relay');
});
check('短标签（<3 字符）不参与包含匹配，避免误吞', () => {
  assert.equal(relayRoleOf('完全无关的一台', { allLabels: ['a'] }), null);
});

console.log('\n▸ 用户实测的那组真实数据（词序不同 + 带宽后缀）');
/** 票据里是长名字（含带宽/线路说明），节点内核里还是改名前的短名字 */
const realNames = {
  allLabels: ['华东-A（2 Mbps）', '常山移动 200Mbps'],
};
check('内核 `PublicServer_阿里云上海` → 第一槽（打洞）', () => {
  assert.equal(relayRoleOf('PublicServer_阿里云上海', realNames), 'relay');
});
check('内核 `PublicServer_常山移动` → 第二槽（中继）', () => {
  assert.equal(relayRoleOf('PublicServer_常山移动', realNames), 'relay');
});
check('票据里的每一台都标「中继节点」（不再有"打洞节点"角色）', () => {
  const roles = ['PublicServer_阿里云上海', 'PublicServer_常山移动'].map((h) => relayRoleOf(h, realNames));
  assert.deepEqual(roles, ['relay', 'relay'], `实际 ${JSON.stringify(roles)}`);
});
check('字符集合匹配是"唯一命中"才认：两台都像时返回 null', () => {
  const ambiguous = { allLabels: ['华东-A（2 Mbps）', '华东-A（200 Mbps）'] };
  // `阿里云上海` 的字符同时出现在两个 label 里 → 不猜
  assert.equal(relayRoleOf('PublicServer_阿里云上海', ambiguous), null);
});

console.log('\n▸ 中继横幅文案（按角色拼，见 src/lib/relay-hint.ts）');
/** 主控下发的结构：当前中继 / 准备好的新中继 */
const hint = { kind: 'switch', currentLabel: '华东-A 2Mbps', targetLabel: '华北-A（200 Mbps）' };

check('switch + 房主 → 有「立即切换」，文案里有"可切换"', () => {
  const copy = relayHintCopy(hint, true);
  assert.equal(copy.action, '立即切换');
  assert.match(copy.body, /已经到容量上限/);
  assert.match(copy.body, /华东-A 2Mbps/);
  assert.match(copy.body, /华北-A（200 Mbps）/);
});

check('switch + 成员 → **没有按钮**，文案写明"需要房主更换"', () => {
  const copy = relayHintCopy(hint, false);
  assert.equal(copy.action, '', '成员在房主切换前不该有可点的动作');
  assert.match(copy.body, /需要房主更换/);
  assert.match(copy.body, /已经到容量上限/);
});

check('notice（没得换）→ 两边都没有按钮，文案说清"暂时没得换"', () => {
  const notice = { kind: 'notice', currentLabel: '华东-A 2Mbps' };
  for (const isHost of [true, false]) {
    const copy = relayHintCopy(notice, isHost);
    assert.equal(copy.action, '');
    assert.match(copy.body, /已经到容量上限/);
    assert.match(copy.body, /没有更空闲的节点可以换/);
  }
});

check('apply（房主已切完）→ 两边都是「重连」', () => {
  for (const isHost of [true, false]) {
    assert.equal(relayHintCopy({ kind: 'apply' }, isHost).action, '重连');
  }
});

check('老主控（只有 message、没有 kind）→ 原样显示 + 保留「现在切换」', () => {
  const copy = relayHintCopy({ message: '这个房间的中继有点挤。' }, false);
  assert.equal(copy.action, '现在切换');
  assert.equal(copy.body, '这个房间的中继有点挤。');
});

check('字段缺失也不会显示成 undefined', () => {
  const copy = relayHintCopy({ kind: 'switch' }, true);
  assert.ok(!/undefined/.test(copy.body) && !/undefined/.test(copy.title));
  assert.match(copy.body, /当前中继/);
});

if (process.exitCode === 1) {
  console.error('\n✗ 有断言失败');
} else {
  console.log(`\n✓ 全部通过（${passed} 条）`);
}
