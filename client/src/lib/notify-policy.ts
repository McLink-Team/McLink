/**
 * 「有人发消息时要不要弹系统通知」的**纯逻辑**。
 *
 * 为什么把判定抽成纯函数（而不是写在 WS 回调里）：
 *   · 三条规则都有"反过来会很难受"的一面 —— 正在看着那个房间还弹（多余）、
 *     自己发的也弹（荒唐）、连发十条弹十个（骚扰）。这些必须在**同一条链路**上判死，
 *     而且要在没有 Electron、没有网络的地方也能断言（见 client/scripts/verify-notify.mjs）。
 *   · CDP 里能验"真的弹了没有"，但验不了"合并窗口是 3 秒"这种时间语义 ——
 *     那是纯逻辑，用可注入的时钟在这里钉死。
 *
 * 判定顺序是有讲究的（从"最不该弹"到"该弹"），下面每条都写了为什么排在那。
 */

/** 同一房间的连发消息在这个窗口内合并成一条通知（3 秒：够合并一次刷屏，又不会让提醒太迟） */
export const MERGE_WINDOW_MS = 3000;

/** 通知正文里消息预览的最大长度（Windows toast 正文约 2 行，超了会被系统截断得很难看） */
export const PREVIEW_MAX_CHARS = 60;

export interface NotifyMessageLike {
  /** 'text'（玩家发言）/ 'system'（加入、离开、被踢…） */
  kind?: string;
  /** 发送者；系统消息可能是 null */
  userId?: string | null;
  displayName?: string;
  body?: string;
}

export interface NotifyContext {
  /** 设置页的「有人发消息时提醒我」（默认开）；关掉之后**一条都不弹** */
  enabled: boolean;
  /** 当前登录用户 id：用来认出"这条是我自己发的" */
  selfUserId: string | null;
  /** 当前会话所在房间：我们只订阅这一个房间的消息 */
  sessionRoomId: string | null;
  /** 窗口是否处于聚焦状态（最小化 / 收进托盘 / 被别的窗口盖住都算 false） */
  windowFocused: boolean;
  /** 房间页此刻是否真的在屏幕上（挂着 ChatPanel 的那一屏） */
  roomOnScreen: boolean;
}

/** 不弹的原因（写清楚是为了日志与自动化断言能指名道姓） */
export type SkipReason = 'disabled' | 'no-session' | 'system' | 'self' | 'already-visible';

export type NotifyDecision = { action: 'skip'; reason: SkipReason } | { action: 'queue' };

/**
 * 该不该为这条消息准备通知。
 *
 * 顺序与理由：
 *   1. **开关关掉** —— 用户说了不要，后面所有判断都不必做（也保证"关掉后 0 条"这条断言成立）。
 *   2. **没有会话 / 不是当前房间** —— 我们只订阅 room:<id>；拿不到会话时也不该假造一个落点。
 *   3. **系统消息** —— "XX 加入了房间"不是"有人说话"，把它也弹出来会让提醒变成噪音。
 *   4. **自己发的** —— 界面里已经有自己的回显；自己的话不需要"提醒自己"。
 *   5. **窗口聚焦且正看着这个房间** —— 消息就在眼前，弹窗纯属打扰。
 *      这两条必须**同时**成立才算"看得见"：窗口在前台但停在设置页，或者窗口失焦但
 *      房间页还挂着（收进托盘），都该弹。
 */
export function decideNotify(message: NotifyMessageLike, context: NotifyContext): NotifyDecision {
  if (!context.enabled) return { action: 'skip', reason: 'disabled' };
  if (!context.sessionRoomId) return { action: 'skip', reason: 'no-session' };
  if (message.kind === 'system') return { action: 'skip', reason: 'system' };
  const sender = message.userId ?? null;
  if (sender !== null && context.selfUserId !== null && sender === context.selfUserId) {
    return { action: 'skip', reason: 'self' };
  }
  if (context.windowFocused && context.roomOnScreen) return { action: 'skip', reason: 'already-visible' };
  return { action: 'queue' };
}

/**
 * 用户回到窗口并看着这个房间时，还没发出去的那批可以**直接丢掉**。
 *
 * 为什么值得单独一条：合并窗口有 3 秒，用户完全可能在这 3 秒里切回来 ——
 * 那时他已经在聊天面板里看到那条消息了，再弹一条"XX 发来消息"就是把刚看过的东西
 * 又推一遍（比不弹更烦）。只在"确实看得见"时丢：停在别的页面时，那批必须照常弹出。
 */
export function shouldDropPending(context: NotifyContext): boolean {
  return context.enabled && context.windowFocused && context.roomOnScreen;
}

/** 合并中的这批通知的摘要 */
export interface Batch {
  roomId: string;
  /** 合并了几条 */
  count: number;
  /** 第一条的发送者（标题用它："XX 等 N 条新消息"） */
  firstSender: string;
  /** 最后一条的发送者（正文用它，读者最关心最新那条是谁说的） */
  lastSender: string;
  /** 最后一条的预览 */
  lastPreview: string;
  startedAt: number;
  lastAt: number;
}

/** 按码点截断（emoji 不会被切成半个），超长补省略号 */
export function clip(text: string, max: number): string {
  const chars = [...String(text ?? '').replace(/\s+/g, ' ').trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`;
}

/** 消息里的显示名；没有就退化成"有人"，绝不显示空标题 */
export function senderName(message: NotifyMessageLike): string {
  const name = String(message.displayName ?? '').trim();
  return name.length > 0 ? name : '有人';
}

export function startBatch(roomId: string, message: NotifyMessageLike, now: number): Batch {
  const sender = senderName(message);
  return {
    roomId,
    count: 1,
    firstSender: sender,
    lastSender: sender,
    lastPreview: clip(String(message.body ?? ''), PREVIEW_MAX_CHARS),
    startedAt: now,
    lastAt: now,
  };
}

/** 把同一房间的新消息并进这批（调用方负责确认房间一致） */
export function appendToBatch(batch: Batch, message: NotifyMessageLike, now: number): Batch {
  return {
    ...batch,
    count: batch.count + 1,
    lastSender: senderName(message),
    lastPreview: clip(String(message.body ?? ''), PREVIEW_MAX_CHARS),
    lastAt: now,
  };
}

/**
 * 通知的标题与正文。
 *
 * 单条：`张三 发来消息` / `【房间名】正文…`
 * 多条：`张三 等 3 条新消息` / `【房间名】最后一条 · 李四：正文…`
 *
 * 为什么标题用"第一条的发送者"而不是"最后一条"：连发时人最容易认出的是一开始那个人
 * （他看到的第一条）；正文里再点出最后一条是谁说的，两条信息都不丢。
 */
export function formatNotification(batch: Batch, roomName: string): { title: string; body: string } {
  const room = String(roomName ?? '').trim();
  const prefix = room.length > 0 ? `【${room}】` : '';
  if (batch.count <= 1) {
    return { title: `${batch.firstSender} 发来消息`, body: `${prefix}${batch.lastPreview}` };
  }
  return {
    title: `${batch.firstSender} 等 ${batch.count} 条新消息`,
    body: `${prefix}最后一条 · ${batch.lastSender}：${batch.lastPreview}`,
  };
}

/**
 * 合并窗口是否已经过去（到点就把这批发出去）。
 *
 * 判据是**从第一条算起**的固定窗口，不是"最后一条之后再过 3 秒"（尾随防抖）：
 * 尾随防抖遇到"一直在说话"的房间会让通知**无限期推迟** —— 那比不合并更糟
 * （安静的房间 3 秒内就该提醒到）。固定窗口最坏只让第一条晚 3 秒。
 */
export function batchExpired(batch: Batch, now: number, windowMs = MERGE_WINDOW_MS): boolean {
  return now - batch.startedAt >= windowMs;
}
