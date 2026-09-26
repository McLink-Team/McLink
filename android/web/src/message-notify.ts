/**
 * 「有人发消息时提醒一下」—— Android 系统通知。
 *
 * ## ⚠️ 必须先说清楚的硬限制：应用被系统杀掉之后，收不到任何提醒
 *
 * 本项目**没有接推送服务**（没有 FCM / 没有厂商推送通道）。通知是这样产生的：
 *
 *     主控 WS 推来消息  →  WebView 里的 JS 收到  →  调 Android 通知 API 弹一条
 *
 * 这条链的每一环都要求**应用进程活着**。而 Android 会在内存紧张、或用户从最近任务里
 * 划掉应用、或厂商省电策略判定"这个应用在后台耗电"时**杀掉进程** ——
 * 进程一死，WebSocket 就断了，也就没有任何东西能触发通知。
 *
 * 换句话说：
 *   · 应用在前台或刚切到后台（进程还活着，WS 还没被掐）→ **能提醒**；
 *   · 应用被划掉 / 被系统回收 → **收不到任何提醒**，直到用户重新打开应用。
 *
 * 想让"关掉应用也能收到"只有两条路，都不在本里程碑范围内：
 *   1. 接 FCM（需要 Google 服务框架，国内机型大面积不可用）或厂商推送；
 *   2. 起一个**常驻前台服务**把进程钉住 —— 代价是一条常驻通知 + 持续耗电，
 *      而且厂商省电策略照样可能杀它。
 *
 * **我们选择不加前台服务**：为了一个"房间聊天提醒"去常驻一条通知并持续耗电，
 * 成本明显大于收益（用户明确说了"能不加就不加"）。这个取舍写在这里，
 * 也写在设置页的开关说明里 —— 见 MobileSettingsPage.vue。
 *
 * ## 判定规则（与桌面端同一套语义，两个平台的行为才对得上）
 *
 *   1. 应用在**前台且正看着那个房间** → 不弹（人就在看，再弹一次是噪音）；
 *   2. 切到后台、或在前台但看的是别的页面（大厅/设置）→ 弹；
 *   3. **自己发的不弹**；
 *   4. 连发多条**合并**：同一房间在一个时间窗内合成一条
 *      「XX 等 N 条新消息」，而不是刷 N 条通知；
 *   5. 点通知 → 打开应用并跳到那个房间（回到「联机」那一屏）。
 *
 * ## 为什么订阅放在外壳层，而不是 ChatPanel 里
 *
 * ChatPanel 只在**房间页挂着**的时候才存在，而规则 2 要的正是
 * "人不在看聊天的时候也要提醒"。所以订阅必须挂在比 ChatPanel 更高的地方
 * （MobileApp 挂载时订阅一次），它不依赖任何面板是否渲染。
 *
 * 这里**没有改主控协议**：用的是 store 现成的 `onRoomChat` 事件流
 * （`room:<id>` WS 话题 → `emitRoomChat`），与 ChatPanel 看到的是同一条流。
 */
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { clientState, onRoomChat } from '../../../client/src/lib/store.ts';

/** 开关的落点（本机偏好，与桌面端存偏好同一个套路：localStorage + 一个读函数） */
const SETTING_KEY = 'mclink.android.notifyMessages';
/** 「问过一次系统权限」的标记：只问一次，反复弹权限框会被用户当骚扰 */
const ASKED_KEY = 'mclink.android.notifyAsked';

/**
 * 合并窗口。同一个房间在这个窗口内的多条消息合成一条通知。
 *
 * 窗口从**第一条未提醒的消息**开始算（不是"每条都重置计时器"）：
 * 后者在有人连续刷屏时会一直往后推，结果是**永远不提醒** —— 一个持续说话的
 * 房间反而最安静，这显然不对。
 */
const COALESCE_MS = 6000;

/** 通知正文的截断长度：超过就省略号，避免一条通知占满锁屏 */
const BODY_MAX = 60;

/* --------------------------------------------------------------- 开关 */

export function notifyEnabled(): boolean {
  try {
    // 默认**开**（用户要求）。只有显式存过 '0' 才算关。
    return localStorage.getItem(SETTING_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setNotifyEnabled(on: boolean): void {
  try {
    localStorage.setItem(SETTING_KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式：本次会话内仍生效，只是记不住 */
  }
}

/* --------------------------------------------------------------- 权限 */

/**
 * 申请通知权限（Android 13+ 需要 POST_NOTIFICATIONS，之前是安装即授予）。
 *
 * 什么时候申请是这里唯一需要判断的事：
 *   · 不问就发 → Android 13+ 上通知**静默不出现**，用户以为功能坏了；
 *   · 一启动就问 → 用户还不知道这应用会通知什么，多半直接拒绝，
 *     而 Android 的权限一旦被拒两次就永久静默，再想打开只能去系统设置里翻。
 *
 * 所以选的时机是**第一次成功进入房间之后**（见 maybeAskPermission 的调用点）：
 * 那时用户刚做完"我要跟人联机"这件事，"有人说话时提醒你"这个请求才有上下文。
 */
async function requestPermission(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const current = await LocalNotifications.checkPermissions();
    if (current.display === 'granted') return true;
    if (current.display === 'denied') return false;
    const asked = await LocalNotifications.requestPermissions();
    return asked.display === 'granted';
  } catch {
    // 插件缺失（例如在浏览器里预览）不该让调用方炸掉
    return false;
  }
}

/** 首次进房时问一次权限；只问一次 */
export async function maybeAskNotifyPermission(): Promise<void> {
  if (!notifyEnabled()) return;
  try {
    if (localStorage.getItem(ASKED_KEY) === '1') return;
    localStorage.setItem(ASKED_KEY, '1');
  } catch {
    /* 记不住就每次都问 —— 比"永远不问"强，因为不问就永远发不出通知 */
  }
  await requestPermission();
}

/** 设置页打开开关时调用：用户主动要，这时就该弹系统权限框 */
export async function enableNotifications(): Promise<boolean> {
  setNotifyEnabled(true);
  return requestPermission();
}

/* --------------------------------------------------------------- 合并与发送 */

interface Pending {
  count: number;
  /** 最近一条的发送者显示名，用来拼「XX 等 N 条新消息」 */
  lastSender: string;
  /** 单条时显示的正文 */
  lastBody: string;
  timer: number;
}

const pending = new Map<string, Pending>();

/**
 * 房间 id → 稳定的通知 id。
 *
 * 为什么需要它：`LocalNotifications.schedule` 用 id 去重 ——
 * **同一个 id 会替换掉上一条通知**，不同 id 会各占一行。
 * 我们要的正是"同一个房间只占一行、内容随新消息更新"，所以同一房间必须每次都算出同一个 id。
 * 用一个简单的 31 位字符串哈希，再把结果夹到安全的正整数范围内。
 */
function notificationId(roomId: string): number {
  let h = 0;
  for (let i = 0; i < roomId.length; i += 1) {
    h = (Math.imul(31, h) + roomId.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 100000;
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= BODY_MAX ? flat : `${flat.slice(0, BODY_MAX - 1)}…`;
}

async function flush(roomId: string, roomName: string): Promise<void> {
  const item = pending.get(roomId);
  if (!item) return;
  pending.delete(roomId);
  window.clearTimeout(item.timer);

  const body =
    item.count > 1
      ? `${item.lastSender} 等 ${item.count} 条新消息`
      : `${item.lastSender}：${truncate(item.lastBody)}`;

  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: notificationId(roomId),
          title: roomName,
          body,
          // extra 会随通知原样带回，点击时用它决定跳去哪个房间
          extra: { roomId },
          // 同一房间的新通知替换旧的，不在通知栏堆成一列
          ongoing: false,
          autoCancel: true,
        },
      ],
    });
  } catch {
    /* 权限被拒 / 插件不可用：静默失败。聊天本身不受影响，这是重点 */
  }
}

/* --------------------------------------------------------------- 安装 */

export interface NotifierHooks {
  /** 用户此刻是不是正看着这个房间（外壳知道，通知层不该去猜 tab 的状态） */
  isViewingRoom: (roomId: string) => boolean;
  /** 点通知后把界面切回房间那一屏 */
  onOpenRoom: (roomId: string) => void;
}

/**
 * 装上通知层。**必须在 MobileApp 挂载时调用一次，且只调用一次** ——
 * 每调用一次就多一个 onRoomChat 订阅者，消息会被重复提醒。
 */
export function installMessageNotifier(hooks: NotifierHooks): void {
  /*
   * 点通知 → 回到那个房间。
   *
   * 这个监听要无条件注册（即使当前开关是关的）：用户在通知栏里点的那条通知，
   * 可能是开关还开着的时候发出来的。注册本身没有副作用，不注册则表现为"点了没反应"。
   */
  if (Capacitor.isNativePlatform()) {
    void LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
      const roomId = (event.notification.extra as { roomId?: string } | undefined)?.roomId;
      if (typeof roomId === 'string' && roomId.length > 0) hooks.onOpenRoom(roomId);
    }).catch(() => {
      /* 插件不可用：点通知就只是打开应用，不影响别的 */
    });
  }

  onRoomChat((event) => {
    // 删除事件与重连补齐事件不提醒：前者不是新内容，后者是补历史
    if (event.type !== 'message') return;
    if (!notifyEnabled()) return;

    const message = event.message;
    // 规则 3：自己发的不弹
    if (message.userId !== null && message.userId === clientState.user?.id) return;
    // 系统消息（「XX 加入了房间」）不弹：它们不是"有人跟你说话"
    if (message.kind === 'system' || message.role === 'system') return;

    const session = clientState.session;
    if (!session || session.room.id !== message.roomId) return;

    // 规则 1：在前台且正看着这个房间 → 不弹
    if (!document.hidden && hooks.isViewingRoom(message.roomId)) return;

    const roomId = message.roomId;
    const roomName = session.room.name;
    const existing = pending.get(roomId);

    if (existing) {
      existing.count += 1;
      existing.lastSender = message.displayName;
      existing.lastBody = message.body;
      return; // 窗口已经在跑，不重置计时器（理由见 COALESCE_MS 的注释）
    }

    const timer = window.setTimeout(() => void flush(roomId, roomName), COALESCE_MS);
    pending.set(roomId, {
      count: 1,
      lastSender: message.displayName,
      lastBody: message.body,
      timer,
    });
  });
}

/**
 * 退出房间 / 退登时把还没发出去的合并通知清掉。
 *
 * 不清理的后果：退房后 6 秒，玩家会收到一条"XX 等 3 条新消息"，
 * 点进去却已经不在那个房间了 —— 一条点不开的通知比没有通知更糟。
 */
export function cancelPendingNotifications(): void {
  for (const [, item] of pending) window.clearTimeout(item.timer);
  pending.clear();
}
