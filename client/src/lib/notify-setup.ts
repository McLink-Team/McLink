/**
 * 通知链路的**装配点**（main.ts 只调这一个函数）。
 *
 * 它做两件事，分开写是因为两件事的寿命完全不同：
 *   1. `installNotifyRuntime()` —— 生产也走：注册聚焦监听、读一次偏好、接上
 *      "房间页在不在屏幕上"这个探针。
 *   2. 测试注入口 —— **只在以 `MCLINK_TEST_HOOKS=1` 启动时**挂到 window 上。
 *
 * 为什么测试注入口要编进生产包：不然就没法对**打包版**做验收（渲染层的桌面桥
 * window.mclink 只有 Electron 里才有，浏览器里测的不是同一件事）。所以它不能
 * 在任何正常启动下存在 —— preload 给出 `MCLINK_TEST_HOOKS === '1'` 这个布尔值，
 * 这里只认它。
 *
 * 为什么单独一个文件而不塞进 notify.ts：注入口要同时引用 store（喂 WS 事件、
 * 造测试会话）与 notify（sink、合并、开关），放在任一模块里都会绕成循环依赖。
 */
import { clientState, handleServerEventForTest, roomOnScreen } from './store.ts';
import {
  applyMessagesEnabled,
  flushPendingNotifications,
  installNotifyRuntime,
  messagesEnabled,
  notifyHistory,
  pendingBatch,
  setFocusProbe,
  setNotifySink,
  type NotifyPayload,
} from './notify.ts';
import { setSoundEnabledProbe } from './notice-sound.ts';

interface NotifyTestHooks {
  /** 喂一条形状与 WS 下发**完全一致**的原始事件：走 store 里同一个 handleServerEvent */
  feedServerEvent(raw: string): Promise<void>;
  /** 伪造"窗口是否聚焦"（CDP 下没法真的用鼠标去点别的窗口抢焦点） */
  setFocusProbe(focused: boolean | null): void;
  /** 换掉"发通知"这一步；传 null 恢复生产路径（真的 Electron Notification） */
  setSink(sink: ((payload: NotifyPayload) => void) | null): void;
  history(): NotifyPayload[];
  pending(): unknown;
  flush(): void;
  /** 造一个最小会话，让 room.message 的房间过滤通过（只写本地状态，不动协议、不连主控） */
  setSession(roomId: string, roomName: string, selfUserId: string): void;
  clearSession(): void;
  /** 与设置页开关**同一条路径**（写主进程偏好 + 更新本地那份） */
  setEnabled(value: boolean): Promise<boolean>;
  enabled(): boolean;
  /** 「房间页在屏幕上吗」——用来构造"看着这个房间"与"在别的页面"两种情况 */
  setRoomOnScreen(value: boolean): void;
}

export function setupNotifications(): void {
  installNotifyRuntime({
    roomOnScreen: () => roomOnScreen.value,
    roomNameOf: (roomId) => {
      const session = clientState.session;
      return session && session.room.id === roomId ? session.room.name : '';
    },
  });
  /**
   * 提示音跟随**同一个**开关（设置页的「有人发消息时提醒我」）：
   * 玩家关掉提醒就是不想被打扰，再单独弹一个"提示音"开关只会让人多猜一层。
   */
  setSoundEnabledProbe(() => messagesEnabled());
  if (window.mclink?.testHooks !== true) return;

  const hooks: NotifyTestHooks = {
    feedServerEvent: (raw) => handleServerEventForTest(raw),
    setFocusProbe: (focused) => setFocusProbe(focused === null ? null : () => focused === true),
    setSink: (sink) => setNotifySink(sink),
    history: () => notifyHistory(),
    pending: () => pendingBatch(),
    flush: () => flushPendingNotifications(),
    setSession: (roomId, roomName, selfUserId) => {
      /**
       * 只填通知判定真正读到的字段（房间 id/名字、自己是谁）。
       * 用显式的 as unknown as：这是**测试夹具**，不是"其实有一份完整会话"的伪装。
       */
      clientState.user = { id: selfUserId, displayName: '测试机' } as unknown as typeof clientState.user;
      clientState.session = {
        room: { id: roomId, name: roomName, code: 'TESTRM' },
        members: [],
        ticket: { configToml: '', launchArgs: [], instanceName: 'test', aclToml: '' },
        isHost: false,
        virtualIp: '10.200.1.2',
        aclRevision: 0,
      } as unknown as typeof clientState.session;
    },
    clearSession: () => {
      clientState.session = null;
    },
    setEnabled: (value) => applyMessagesEnabled(value),
    enabled: () => messagesEnabled(),
    setRoomOnScreen: (value) => {
      roomOnScreen.value = value === true;
    },
  };
  (window as unknown as { __mclinkNotifyTest?: NotifyTestHooks }).__mclinkNotifyTest = hooks;
  console.log('[notify] 测试注入口已安装（window.__mclinkNotifyTest）');
}
