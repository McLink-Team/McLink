#!/usr/bin/env node
/**
 * 消息提醒（系统通知）的**纯逻辑**校验。
 *
 * 为什么要有它：通知这件事最难验的不是"能不能弹"，而是**什么时候不该弹** ——
 * 正在看着房间还弹、自己发的也弹、连发十条弹十个，这三种都是"功能做出来了但很讨厌"。
 * 它们又都不适合只靠 CDP 验（要么要等真实时间，要么要真的抢焦点）。
 * 所以判定与合并抽成纯函数（client/src/lib/notify-policy.ts），
 * 在这里用构造数据逐条钉死；"真的弹出来了没有"由 .cache/verify-notify-cdp.mjs 负责。
 *
 * 用法：node client/scripts/verify-notify.mjs
 */
import {
  MERGE_WINDOW_MS,
  PREVIEW_MAX_CHARS,
  appendToBatch,
  batchExpired,
  clip,
  decideNotify,
  formatNotification,
  senderName,
  shouldDropPending,
  startBatch,
} from '../src/lib/notify-policy.ts';

let failed = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`);
}
function ok(cond, label) {
  eq(Boolean(cond), true, label);
}
function section(title) {
  console.log(`\n== ${title} ==`);
}

/** 一条"别人的"普通发言 */
const msg = (patch = {}) => ({
  kind: 'text',
  userId: 'u-friend',
  displayName: '小明',
  body: '在吗',
  ...patch,
});

/** 一套"该弹"的上下文：开着、有会话、窗口在后台、不在房间页 */
const ctx = (patch = {}) => ({
  enabled: true,
  selfUserId: 'u-me',
  sessionRoomId: 'room-1',
  windowFocused: false,
  roomOnScreen: false,
  ...patch,
});

/* ------------------------------------------------------------ 判定：不该弹 */

section('不该弹的四种情况');
eq(decideNotify(msg(), ctx()), { action: 'queue' }, '基线：窗口失焦 + 别人的消息 → 该弹');

eq(
  decideNotify(msg(), ctx({ windowFocused: true, roomOnScreen: true })),
  { action: 'skip', reason: 'already-visible' },
  '窗口聚焦 **且** 正看着这个房间 → 不弹（消息就在眼前）',
);

eq(
  decideNotify(msg(), ctx({ windowFocused: true, roomOnScreen: false })),
  { action: 'queue' },
  '窗口聚焦但停在别的页面（没看着房间）→ 仍然要弹',
);

eq(
  decideNotify(msg(), ctx({ windowFocused: false, roomOnScreen: true })),
  { action: 'queue' },
  '房间页还挂着但窗口失焦（收进托盘/最小化）→ 仍然要弹',
);

eq(
  decideNotify(msg({ userId: 'u-me', displayName: '我自己' }), ctx()),
  { action: 'skip', reason: 'self' },
  '自己发的消息 → 不弹（界面里已经有回显）',
);

eq(
  decideNotify(msg({ kind: 'system', userId: null, displayName: '系统', body: '小明加入了房间' }), ctx()),
  { action: 'skip', reason: 'system' },
  '系统消息（加入/离开）→ 不弹（它不是"有人说话"）',
);

eq(decideNotify(msg(), ctx({ enabled: false })), { action: 'skip', reason: 'disabled' }, '开关关掉 → 不弹');
eq(
  decideNotify(msg(), ctx({ enabled: false, windowFocused: false })),
  { action: 'skip', reason: 'disabled' },
  '开关关掉时，其它条件再"该弹"也不弹（短路在第一位）',
);
eq(decideNotify(msg(), ctx({ sessionRoomId: null })), { action: 'skip', reason: 'no-session' }, '没有会话 → 不弹（不假造落点）');
eq(
  decideNotify(msg({ userId: null }), ctx()),
  { action: 'queue' },
  'userId 为空的普通发言（历史数据/匿名）→ 仍然要弹（不当成自己发的）',
);
eq(
  decideNotify(msg({ userId: 'u-me' }), ctx({ selfUserId: null })),
  { action: 'queue' },
  '还不知道自己是谁时不误判成"自己发的"（宁可弹一次）',
);

/* ------------------------------------------------------------ 合并与文案 */

section(`合并：${MERGE_WINDOW_MS}ms 固定窗口内的连发合成一条`);

const t0 = 1_000_000;
let batch = startBatch('room-1', msg({ body: '第一条' }), t0);
eq(batch.count, 1, '第一批只有 1 条');
ok(!batchExpired(batch, t0 + MERGE_WINDOW_MS - 1), '窗口没到 → 先不发（继续攒）');
ok(batchExpired(batch, t0 + MERGE_WINDOW_MS), '窗口到点 → 发出去');

batch = appendToBatch(batch, msg({ displayName: '小红', body: '第二条' }), t0 + 800);
batch = appendToBatch(batch, msg({ displayName: '小刚', body: '第三条' }), t0 + 1600);
eq(batch.count, 3, '3 条并进同一批（不会弹 3 次）');
eq(batch.firstSender, '小明', '批的"第一个人"仍是第一条的发送者');
eq(batch.lastSender, '小刚', '正文取最后一条的发送者');
eq(batch.lastPreview, '第三条', '正文取最后一条的内容');
ok(batchExpired(batch, t0 + MERGE_WINDOW_MS), '合并窗口仍然从**第一条**算起（不是尾随防抖，避免一直说话就永不提醒）');

section('通知文案');
eq(
  formatNotification(startBatch('room-1', msg({ body: '来一把？' }), t0), '周五联机'),
  { title: '小明 发来消息', body: '【周五联机】来一把？' },
  '单条：标题是发送者，正文是消息（带房间名）',
);
const merged = appendToBatch(appendToBatch(startBatch('room-1', msg(), t0), msg(), t0 + 1), msg({ displayName: '小红', body: '最后一条' }), t0 + 2);
eq(
  formatNotification(merged, '周五联机'),
  { title: '小明 等 3 条新消息', body: '【周五联机】最后一条 · 小红：最后一条' },
  '多条：标题"XX 等 N 条新消息"，正文点出最后一条是谁说的',
);
eq(formatNotification(startBatch('room-1', msg(), t0), ''), { title: '小明 发来消息', body: '在吗' }, '房间名拿不到时不出现空的【】');

section('文案边界');
eq(senderName({ displayName: '   ' }), '有人', '发送者名字为空时退化为"有人"（通知标题不能是空的）');
eq([...clip('好'.repeat(200), PREVIEW_MAX_CHARS)].length, PREVIEW_MAX_CHARS + 1, `超长正文按码点截断到 ${PREVIEW_MAX_CHARS} 字 + 省略号`);
eq(clip('a\n\nb   c', 20), 'a b c', '正文里的换行/连续空格压成单个空格（toast 正文是单段）');
eq(clip('😀😀😀', 2), '😀😀…', '按码点截断，emoji 不会被切成半个');

section('用户回到窗口：待发的那批可以直接丢');
ok(
  shouldDropPending({ enabled: true, windowFocused: true, roomOnScreen: true, selfUserId: null, sessionRoomId: 'room-1' }),
  '聚焦 + 正看着房间 → 丢掉待发批次（他已经在聊天面板里看到了）',
);
ok(
  !shouldDropPending({ enabled: true, windowFocused: true, roomOnScreen: false, selfUserId: null, sessionRoomId: 'room-1' }),
  '聚焦但停在别的页面 → 不能丢（那批还得弹）',
);
ok(
  !shouldDropPending({ enabled: false, windowFocused: true, roomOnScreen: true, selfUserId: null, sessionRoomId: 'room-1' }),
  '开关关掉时也不该有"丢"以外的语义（这里是幂等的 false 分支）',
);

console.log(`\n${'='.repeat(72)}`);
if (failed === 0) {
  console.log('通知判定与合并：全部通过。');
  console.log('（"真的弹出来了没有"由 .cache/verify-notify-cdp.mjs 在打包版上验）');
  process.exit(0);
}
console.log(`失败 ${failed} 项。`);
process.exit(1);
