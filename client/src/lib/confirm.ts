/**
 * 应用内确认弹层 —— Promise 风格的调用口。
 *
 * 为什么要有它（用户实测反馈）：以前"退出房间 / 关闭房间 / 轮换密钥 / 踢人 / 删除消息"
 * 都走主进程的原生 `dialog.showMessageBox`（`window.mclink.confirm`）。那个框是
 * **Windows 系统样式**的浅色对话框配蓝色箭头图标，和客户端现在这套「暖纸台」世界
 * （暖纸底、白卡、摩卡强调色、圆角 16/18/20）完全不是一路；而且它是原生窗口，
 * 自动化测试里 CDP 看不见、也截不到图，只能靠人去点。
 *
 * 现在的形态：所有确认都走这一处应用内 DOM 弹层（组件见 components/ConfirmDialog.vue，
 * 在 App.vue 里挂一次，任何一屏都能弹），调用点写起来和以前一样顺手：
 *
 * ```ts
 * const ok = await confirmInApp({
 *   title: '退出房间',
 *   message: '确定退出这个房间吗？',
 *   detail: '……',
 *   confirmText: '退出房间',
 *   danger: true,
 * });
 * if (!ok) return;
 * ```
 *
 * 主进程那条 `dialog:confirm` 桥**保留不动**（对外契约，删了以后想用还得加回来），
 * 只是渲染层不再有调用点 —— 它现在只作为兜底（见 electron/main.cjs）。
 *
 * 状态放模块级而不是 provide/inject：调用点是普通函数（`doLeave()`、`remove()`），
 * 它们不在组件的 setup 作用域里，拿不到 inject。
 */
import { ref } from 'vue';

export interface ConfirmOptions {
  /** 标题：写清要做的动作（「退出房间」），不要写「你确定吗」 */
  title: string;
  /** 正文：一句话说清"点了会发生什么" */
  message: string;
  /** 补充说明（可省）：为什么要问、有什么后遗症 */
  detail?: string;
  /**
   * 确定按钮的文字：**写动作**（「退出房间」「关闭房间」），不写「确定」——
   * 这是仓库既有的文案原则（按钮自己说清按下去会做什么）。
   * 省略时退回标题，标题本身就是动作名，不会出现"确定"这种无信息量的按钮。
   */
  confirmText?: string;
  /** 取消按钮的文字，默认「取消」 */
  cancelText?: string;
  /** 破坏性动作：确定键走 `.btn-danger` 的语义色（红字 + 红描边），而不是实心强调色 */
  danger?: boolean;
}

/** 归一化之后的一份完整询问（组件只读这个，不用再判空） */
export interface ConfirmRequest extends Required<ConfirmOptions> {}

/** 当前要问的问题；null = 没有弹层 */
export const confirmRequest = ref<ConfirmRequest | null>(null);

/** 等待回答的那个 Promise 的 resolve */
let settle: ((ok: boolean) => void) | null = null;

/**
 * 当前有没有挂着 `ConfirmDialog`（由组件自己在挂载/卸载时置位）。
 *
 * ## 为什么需要这个标志 —— 这是一次真机事故换来的
 *
 * 安卓外壳一开始**没有挂** ConfirmDialog，而 `confirmInApp` 的 Promise 只有那个组件
 * 会 resolve。于是玩家点「踢出成员」「退出房间」时：请求发了（其实没发）、
 * 弹层没有、Promise 永远悬着 —— **按钮变成哑巴，且不报任何错**。
 * 用户的原话是"点踢出没有反应"。
 *
 * 挂载状态是这里唯一能自查的事实，所以没弹层时**退回桥上的 confirm**
 * （Electron 是主进程原生框，移动端是系统 confirm）：样式不统一，
 * 但比一个点了没反应的按钮好得多。
 */
let dialogMounted = false;

/** 由 ConfirmDialog 在 onMounted / onUnmounted 里调用 */
export function setConfirmDialogMounted(value: boolean): void {
  dialogMounted = value;
}

/**
 * 弹一个应用内确认框，返回用户的选择（确定 = true，取消 / Esc = false）。
 *
 * 同时只有一个弹层：万一在弹层还没答完时又来了一个（例如连点两次"踢出"），
 * 把前一个当成"取消"结掉，由新的接管 —— 否则两个遮罩会叠在一起，
 * 前一个 Promise 永远不会 settle。
 */
export function confirmInApp(options: ConfirmOptions): Promise<boolean> {
  // 归一化只做一次：兜底路径与弹层路径用的是同一份值，不会出现两种措辞
  const request: ConfirmRequest = {
    title: options.title,
    message: options.message,
    detail: options.detail ?? '',
    // 兜底就是标题：标题按约定已经是动作名，不会出现「确定」这种按钮
    confirmText: options.confirmText || options.title,
    cancelText: options.cancelText || '取消',
    danger: Boolean(options.danger),
  };

  if (!dialogMounted) return confirmViaBridge(request);

  settle?.(false);
  confirmRequest.value = request;
  return new Promise<boolean>((resolve) => {
    settle = resolve;
  });
}

/**
 * 没有应用内弹层时的兜底：走 `window.mclink.confirm`（Electron 原生框 / 移动端系统 confirm），
 * 连这个桥都没有（纯浏览器里跑）就退化成内置 `confirm`。
 *
 * **任何一种情况都必须 settle** —— 这个函数的失败模式不该是"永远不返回"。
 */
async function confirmViaBridge(request: ConfirmRequest): Promise<boolean> {
  const text = [request.title, request.message, request.detail].filter(Boolean).join('\n\n');
  const bridge = globalThis.window?.mclink?.confirm;
  if (typeof bridge === 'function') {
    try {
      return Boolean(await bridge({ title: request.title, message: request.message, detail: request.detail }));
    } catch {
      return false;
    }
  }
  try {
    return globalThis.confirm ? globalThis.confirm(text) : false;
  } catch {
    return false;
  }
}

/**
 * 由 ConfirmDialog 调用：用户答完了（确定 / 取消 / Esc / 点遮罩）。
 * 先收弹层再 resolve —— resolve 之后调用点会立刻执行下一步（可能又弹一个框），
 * 顺序反过来的话新弹层会被这一句清掉。
 */
export function answerConfirm(ok: boolean): void {
  const done = settle;
  settle = null;
  confirmRequest.value = null;
  done?.(ok);
}
