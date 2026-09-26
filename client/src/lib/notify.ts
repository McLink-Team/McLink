/**
 * 系统通知的**运行时**：谁来弹、怎么合并、什么时候丢。
 *
 * 纯判定在 notify-policy.ts（可在 node 里断言），这里只做三件事：
 *   1. 把"该弹"的消息按房间攒成一批（合并窗口见 MERGE_WINDOW_MS）；
 *   2. 到点后交给 **sink** 发出去 —— 生产路径的 sink 就是 `window.mclink.notify.show`
 *      （preload → 主进程 `new Notification(...)`）。**渲染层不自己 new Notification**：
 *      点通知要"恢复窗口 + 跳到那个房间"，而恢复窗口只有主进程做得到；
 *      主进程拿着这条通知，点击时才能把窗口叫回来。
 *   3. 给自动化留一个**可注入的 sink**：CDP 测试要断言"弹了几条、内容是什么"，
 *      而真弹系统通知在无人值守的机器上没法计数。注入只替换 sink，判定与合并
 *      仍然走生产代码（这就是为什么 sink 是一等公民，而不是测试专用的旁路）。
 *
 * 平台差异不在这个文件里：Windows 的 toast 与 macOS 的通知中心都由 Electron 的
 * `Notification` 负责，差异（AppUserModelId、权限被拒）在主进程处理，见 main.cjs。
 */
import {
  MERGE_WINDOW_MS,
  appendToBatch,
  decideNotify,
  formatNotification,
  shouldDropPending,
  startBatch,
  type Batch,
  type NotifyContext,
  type NotifyDecision,
  type NotifyMessageLike,
} from './notify-policy.ts';

/** 一条待发出的通知（主进程只用这三个字段） */
export interface NotifyPayload {
  title: string;
  body: string;
  /** 点通知后要跳回的房间；主进程只把它回传给渲染层，不解释它 */
  roomId: string;
}

export type NotifySink = (payload: NotifyPayload) => void;

/** 最近发出的通知（排查用：设置页/日志能看出"到底弹了什么"，也便于自动化断言） */
const sent: NotifyPayload[] = [];
const SENT_KEEP = 20;

/** 房间名：判定与合并都不需要它，但通知正文里要有（读者得知道是哪个房间） */
let roomNameOf: (roomId: string) => string = () => '';

/**
 * 「房间页此刻在屏幕上吗」——由 store 注入（RoomPage 挂载/卸载时写状态）。
 * 这个事实只有界面知道，所以做成探针而不是让通知模块去猜。
 */
let roomOnScreenProbe: () => boolean = () => false;

let sink: NotifySink | null = null;
let pending: Batch | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let enabled = true;
let installed = false;

/**
 * 聚焦探针。
 *
 * 默认用 `document.hasFocus()`：最小化、收进托盘、被别的窗口盖住时它都是 false，
 * 而且这是**渲染进程唯一可信**的聚焦事实（读主进程的 isFocused 要跨进程、还会滞后）。
 * 抽成变量是为了让 CDP 测试能伪造聚焦状态（那个环境下没法真的用鼠标点别的窗口）。
 */
let focusProbe: () => boolean = () => document.hasFocus();

function productionSink(payload: NotifyPayload): void {
  /**
   * 桌面端（Windows/macOS）：真的走 Electron Notification（主进程）。
   * 没有这个桥（Android 端走 Capacitor 的 LocalNotifications）时**什么都不做** ——
   * 移动端由自己的启动代码调 setNotifySink 接上系统通知，
   * 判定与合并（这个文件上面的部分）两端共用，不必各写一遍。
   */
  const bridge = window.mclink?.notify;
  if (!bridge) return;
  void bridge.show(payload);
}

function deliver(payload: NotifyPayload): void {
  sent.push(payload);
  if (sent.length > SENT_KEEP) sent.splice(0, sent.length - SENT_KEEP);
  try {
    (sink ?? productionSink)(payload);
  } catch {
    /* 通知失败绝不能影响聊天本身 */
  }
}

/** 设置页的开关：关掉之后一条都不弹（判定里第一个短路） */
export function setMessagesEnabled(value: boolean): void {
  enabled = value;
  if (!enabled) flushPendingNotifications({ drop: true });
}
export function messagesEnabled(): boolean {
  return enabled;
}

/**
 * 设置页开关的**唯一落点**：写主进程偏好 + 立刻更新本地那份。
 *
 * 为什么两件事必须一起做：偏好存在主进程（重启后仍生效），而判定要在 WS 消息
 * 到手的那一瞬间同步读它（见 installNotifyRuntime 的注释）—— 只写主进程的话，
 * 本次会话里还得等下一次重启才生效，用户会以为开关坏了。
 */
export async function applyMessagesEnabled(value: boolean): Promise<boolean> {
  const bridge = window.mclink?.setNotifyMessages;
  if (!bridge) {
    // 该平台还没有"落盘"的通道（移动端未接）：至少让本次会话的开关生效
    setMessagesEnabled(value);
    return messagesEnabled();
  }
  const res = await bridge(value);
  setMessagesEnabled(res.notifyMessages !== false);
  return messagesEnabled();
}

export function windowIsFocused(): boolean {
  try {
    return focusProbe() === true;
  } catch {
    return false;
  }
}

function buildContext(extra: { sessionRoomId: string | null; selfUserId: string | null }): NotifyContext {
  return {
    enabled,
    selfUserId: extra.selfUserId,
    sessionRoomId: extra.sessionRoomId,
    windowFocused: windowIsFocused(),
    roomOnScreen: roomOnScreenProbe() === true,
  };
}

/**
 * 收到一条**别人**的房间消息：判定 → 入批（必要时推迟）→ 到点发出。
 *
 * 返回判定结果，纯粹是为了让调用方（store）能写日志、让测试能断言；
 * 生产路径不依赖返回值。
 */
export function handleIncomingMessage(
  message: NotifyMessageLike,
  extra: { sessionRoomId: string | null; selfUserId: string | null; roomName?: string },
): NotifyDecision {
  const context = buildContext(extra);
  const decision = decideNotify(message, context);
  if (decision.action === 'skip') return decision;

  const roomId = String(context.sessionRoomId ?? '');
  if (extra.roomName !== undefined) roomNameOf = () => String(extra.roomName ?? '');

  const now = Date.now();
  /**
   * 同一房间的连发并进同一批；换了房间（理论上不会发生，我们只订阅一个房间）
   * 就先把上一批发出去 —— 通知的落点是房间，混在一起会点错地方。
   */
  if (pending && pending.roomId !== roomId) flushPendingNotifications();
  pending = pending ? appendToBatch(pending, message, now) : startBatch(roomId, message, now);

  if (timer === null) {
    const wait = Math.max(0, MERGE_WINDOW_MS - (now - pending.startedAt));
    timer = setTimeout(() => {
      timer = null;
      flushPendingNotifications();
    }, wait);
  }
  return decision;
}

/**
 * 把这批通知发出去。
 * `drop: true` = 不发了（用户回到窗口且正看着房间，或者开关被关掉）。
 */
export function flushPendingNotifications(options: { drop?: boolean } = {}): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const batch = pending;
  pending = null;
  if (!batch) return;
  if (options.drop) return;
  const { title, body } = formatNotification(batch, roomNameOf(batch.roomId));
  deliver({ title, body, roomId: batch.roomId });
}

/** 窗口重新获得焦点时调用：用户可能已经看着聊天面板了，那批就不必再弹 */
export function onWindowFocus(): void {
  if (!pending) return;
  // 只关心"看得见吗"：会话、发送者这些条件与**已经攒下**的这批无关
  if (shouldDropPending({ enabled, selfUserId: null, sessionRoomId: pending.roomId, windowFocused: windowIsFocused(), roomOnScreen: roomOnScreenProbe() === true })) {
    flushPendingNotifications({ drop: true });
  }
}

/* ------------------------------------------------------------ 测试与排查 */

export function notifyHistory(): NotifyPayload[] {
  return [...sent];
}

/** 注入 sink（传 null 恢复生产路径 = 真的调 Electron） */
export function setNotifySink(next: NotifySink | null): void {
  sink = next;
}

export function setFocusProbe(next: (() => boolean) | null): void {
  focusProbe = next ?? (() => document.hasFocus());
}

export function setRoomOnScreenProbe(next: (() => boolean) | null): void {
  roomOnScreenProbe = next ?? (() => false);
}

export function setRoomNameResolver(next: ((roomId: string) => string) | null): void {
  roomNameOf = next ?? (() => '');
}

/** 待发批次（测试断言"3 条合并成一批"用；生产中没人读它） */
export function pendingBatch(): Batch | null {
  return pending;
}

/**
 * 安装运行时：聚焦/失焦监听 + 从主进程读一次偏好。
 *
 * 为什么偏好要在渲染层留一份：判定发生在 WS 消息到手的那一瞬间，必须**同步**拿到开关值；
 * 每次去问主进程（IPC）会让判定变成异步，判完窗口可能已经聚焦了。
 * 所以：启动读一次、设置页改的时候同步更新（setMessagesEnabled 与 IPC 一起调）。
 */
export function installNotifyRuntime(options: {
  /** 「房间页在屏幕上吗」——store 注入（RoomPage 挂载/卸载写状态） */
  roomOnScreen: () => boolean;
  /** 房间 id → 房间名（通知正文里的【房间名】） */
  roomNameOf?: (roomId: string) => string;
}): void {
  roomOnScreenProbe = options.roomOnScreen;
  if (options.roomNameOf) roomNameOf = options.roomNameOf;
  if (installed) return;
  installed = true;
  window.addEventListener('focus', onWindowFocus);
  void window.mclink
    .info()
    .then((info) => {
      enabled = info.notifyMessages !== false;
    })
    .catch(() => {
      /* 拿不到就按默认（开）走：宁可多提醒一次，也不要静默地什么都不弹 */
    });
}

export { MERGE_WINDOW_MS };
