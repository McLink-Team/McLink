#!/usr/bin/env node
/**
 * 房间页「打洞节点 / 中继节点」角色判定的回归脚本（纯逻辑，不需要 Electron / 网络）。
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
check('没有前缀的名字不动（前缀只在开头剥一次）', () => {
  assert.equal(relayNameKey('阿里云上海'), '阿里云上海');
  assert.equal(relayNameKey('常山_PublicServer_移动'), '常山_publicserver_移动');
});

console.log('\n▸ 角色判定（票据 relays[0] = 打洞节点）');
const names = { punchLabel: '阿里云上海', allLabels: ['阿里云上海', '常山移动'] };
check('带前缀的两行分别判成打洞 / 中继（这次 bug 的回归断言）', () => {
  assert.equal(relayRoleOf(`${PUBLIC_SERVER_PREFIX}阿里云上海`, names), 'punch');
  assert.equal(relayRoleOf(`${PUBLIC_SERVER_PREFIX}常山移动`, names), 'relay');
});
check('两行不会都被判成同一个角色', () => {
  const roles = [`${PUBLIC_SERVER_PREFIX}阿里云上海`, `${PUBLIC_SERVER_PREFIX}常山移动`].map((h) =>
    relayRoleOf(h, names),
  );
  assert.equal(new Set(roles).size, 2, `两行角色必须不同，实际 ${JSON.stringify(roles)}`);
});
check('不带前缀的内核 hostname 也能对上', () => {
  assert.equal(relayRoleOf('阿里云上海', names), 'punch');
  assert.equal(relayRoleOf('常山移动', names), 'relay');
});
check('只有一台中继时那台就是打洞槽', () => {
  assert.equal(relayRoleOf(`${PUBLIC_SERVER_PREFIX}阿里云上海`, { punchLabel: '阿里云上海', allLabels: ['阿里云上海'] }), 'punch');
});

console.log('\n▸ 认不出来时宁可不标');
check('不在票据里的 peer（别的房间 / 陌生节点）→ null', () => {
  assert.equal(relayRoleOf('北京的某台机器', names), null);
  assert.equal(relayRoleOf(`${PUBLIC_SERVER_PREFIX}北京的某台机器`, names), null);
});
check('空 hostname / 空票据 → null', () => {
  assert.equal(relayRoleOf('', names), null);
  assert.equal(relayRoleOf('   ', names), null);
  assert.equal(relayRoleOf('阿里云上海', { punchLabel: null, allLabels: [] }), null);
});
check('票据里没有 punchLabel 时（老主控只给一台）→ null，不瞎猜', () => {
  assert.equal(relayRoleOf('阿里云上海', { punchLabel: null, allLabels: ['阿里云上海'] }), null);
});

if (process.exitCode === 1) {
  console.error('\n✗ 有断言失败');
} else {
  console.log(`\n✓ 全部通过（${passed} 条）`);
}
