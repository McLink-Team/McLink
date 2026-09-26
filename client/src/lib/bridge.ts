/** preload 暴露的窗口 API 的类型声明 */
import type { CoreStatus, CoreLogEntry, CliResult } from './core-types.ts';

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  userData: string;
  dataDir: string;
  logDir: string;
  vendorDir: string;
  coreBin: string;
  cliBin: string;
  elevated: boolean;
  /**
   * 权限不足时的可读原因（受限令牌 / 未提权）；够权限时为 null。
   * 存在的意义：光看 `elevated` 说不清"为什么建不了虚拟网卡"，
   * 例如用 `runas /trustlevel` 启动时完整性级别仍是 High，但令牌是受限的。
   */
  elevationReason?: string | null;
  /** 可执行文件路径与其所在目录：自动提权失败时，带用户去文件所在处（Windows 才谈得上"右键→以管理员身份运行"） */
  exePath?: string;
  exeDir?: string;
  /** 启动时是否自动请求管理员权限（默认 true） */
  autoElevate: boolean;
  /** 有人在房间说话时弹系统通知（默认 true）；关掉后一条都不弹 */
  notifyMessages?: boolean;
  /** 当前系统能不能弹通知（macOS 可能关了通知权限；Windows 可能是精简系统） */
  notificationsSupported?: boolean;
  /** 关闭窗口时的行为：ask（默认）/ tray / quit */
  closeAction?: CloseAction;
  /** true = 正在用软件渲染（此前观测到 GPU 进程异常，或设了 MCLINK_DISABLE_GPU=1） */
  softwareRendering?: boolean;
  hostname: string;
}

/** 关闭窗口时的行为：询问 / 最小化到托盘 / 彻底退出 */
export type CloseAction = 'ask' | 'tray' | 'quit';

/**
 * 通知调用的返回：既当"这次成功了吗"，也当"通知实况"。
 * `shown` 是**系统真的显示出来**的次数，`requested` 是渲染层请求的次数 ——
 * 两个数不一样时（例如 macOS 被拒权限、Windows 没有开始菜单快捷方式），
 * 就说明问题在系统侧而不是我们的判定里。
 */
export interface NotifyResult {
  ok: boolean;
  error?: string;
  supported?: boolean;
  /** Windows 才有的 toast 身份标识；其它平台为 null */
  appUserModelId?: string | null;
  requested?: number;
  shown?: number;
  failed?: number;
  lastError?: string | null;
}

/**
 * TCP 延迟探测的目标：中继节点的**链接地址**（host + 端口）。
 * 端口是客户端真正要连的那个（主控按链接端口下发，见 server/src/db/nodes.ts）。
 */
export interface ProbeTarget {
  host: string;
  port: number;
}

/** 探测结果的键：与主进程 `net:tcping` 的返回键一致（`host:port`） */
export function probeKey(target: ProbeTarget): string {
  return `${target.host}:${target.port}`;
}

export interface MclinkBridge {
  /**
   * 平台标识（`process.platform`，preload 同步给出）。
   * 与 AppInfo.platform 是同一个值，但**同步可读** —— 首屏就要按平台分支的
   * 文案与按钮（标题栏的窗口控制、提权措辞）不能等一次 IPC，否则会先闪一帧 Windows 版。
   */
  platform: string;
  /**
   * 自动化注入口是否开启（`MCLINK_TEST_HOOKS=1`，只有桌面端提供）。
   *
   * 这几个新能力**刻意是可选的**：这份接口现在同时被 Android 端实现
   * （android/web/src/mobile-bridge.ts），而"弹通知"在移动端要走 Capacitor 的
   * LocalNotifications，不是同一个桥。可选 + 渲染层防御，能让桌面端先跑起来、
   * 移动端按自己的节奏接（详见 lib/notify.ts 里 productionSink 的兜底）。
   */
  testHooks?: boolean;
  info(): Promise<AppInfo>;
  freePort(): Promise<number>;
  /**
   * TCP 延迟探测（tcping，建房页选节点用）：对每个中继的链接端口**连打 3 次**、取最快的一次，
   * 返回 `{ "host:port": 最小时延 ms | null }`，3 次都没连上是 null。
   *
   * 为什么不是 ICMP：量的是**真正要走的那个端口**，"连不上"因此基本等于"用不了"。
   * 为什么要 3 次：偶发丢包不该让整行显示「—」。但仍然**只用于展示与排序** ——
   * 三次都失败也可能只是那几秒的抖动，不该让节点从选单里消失。
   */
  tcping(targets: ProbeTarget[]): Promise<Record<string, number | null>>;
  openPath(target: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  relaunchElevated(): Promise<{ ok: boolean; error?: string }>;
  setAutoElevate(enabled: boolean): Promise<{ ok: boolean; autoElevate: boolean }>;
  /**
   * 「有人发消息时提醒我」开关（写进 client-prefs.json）。
   * 可选：移动端接入自己的通知实现时再补（见 testHooks 的说明）。
   */
  setNotifyMessages?(enabled: boolean): Promise<{ ok: boolean; notifyMessages: boolean }>;
  /**
   * 系统通知（Windows = toast，macOS = 通知中心）。
   * 判定在渲染层（只有它知道"谁看得见这条消息"），**弹**在主进程 ——
   * 点通知要把窗口从托盘/菜单栏叫回来，那只有主进程做得到。
   * 可选：移动端没有这个桥（走 Capacitor LocalNotifications + setNotifySink 注入）。
   */
  notify?: {
    show(payload: { title: string; body: string; roomId: string }): Promise<NotifyResult>;
    /** 通知实况：supported / requested / shown / failed（排查"为什么没弹"） */
    state(): Promise<NotifyResult>;
    /** 用户点了通知：主进程已把窗口叫回来，这里只需跳到那个房间 */
    onActivate(handler: (payload: { roomId: string | null }) => void): () => void;
    /**
     * 自动化专用（`MCLINK_TEST_HOOKS=1` 时才存在）：
     * 让主进程走一遍「通知被点击」的落点 —— 系统通知的点击没法用脚本模拟。
     */
    simulateClickForTest?(roomId: string): Promise<{ ok: boolean }>;
  };
  /** 设置页里改"关闭窗口时的默认行为" */
  setCloseAction(value: CloseAction): Promise<{ ok: boolean; closeAction: CloseAction }>;
  /** 主进程问"彻底退出还是最小化"时的回调（返回取消订阅的函数） */
  onAskClose(handler: () => void): () => void;
  /**
   * macOS 菜单栏发来的命令（当前只有 'settings'，对应 ⌘,）。
   * Windows 上不会触发：那个平台不建原生菜单。
   */
  onMenuCommand(handler: (command: string) => void): () => void;
  /** 询问框已经弹出（撤掉主进程的 8 秒兜底） */
  closeAskOpened(): Promise<{ ok: boolean }>;
  /** 回答主进程的选择；remember=true 时把它记成默认 */
  closeDecision(payload: {
    action: 'tray' | 'quit' | 'cancel';
    remember: boolean;
  }): Promise<{ ok: boolean; action?: string; error?: string }>;
  confirm(payload: { title?: string; message?: string; detail?: string }): Promise<boolean>;
  /**
   * 自绘标题栏的窗口控制。
   *
   * Windows/Linux：窗口是无边框的（frame: false），最小化/最大化/关闭都由界面触发。
   * macOS：窗口用 titleBarStyle: 'hiddenInset'，**这三个按钮由系统红黄绿担任**
   * （渲染层不画它们），但这组 API 仍然保留 —— 契约不变，行为只在渲染层分支。
   */
  win: {
    minimize(): Promise<boolean | null>;
    toggleMaximize(): Promise<boolean | null>;
    isMaximized(): Promise<boolean | null>;
    close(): Promise<boolean | null>;
    hide(): Promise<boolean | null>;
    onMaximized(handler: (flag: boolean) => void): () => void;
  };
  core: {
    start(payload: { configToml: string; launchArgs?: string[]; instanceName?: string }): Promise<CoreStatus>;
    stop(): Promise<CoreStatus>;
    status(): Promise<CoreStatus>;
    logs(limit?: number): Promise<CoreLogEntry[]>;
    /**
     * 核心进程的资源占用。两个平台返回**同一形状**：
     * Windows 走 `Get-Process`（WorkingSet64 字节 / CPU 秒），
     * macOS/Linux 走 `ps -o rss=,time=` 后归一成同样的两项（避免调用方还要判平台）。
     */
    resourceUsage(): Promise<{ WorkingSet64?: number; CPU?: number } | null>;
    applyAcl(aclToml: string): Promise<{ ok: boolean; mode?: 'hot' | 'restart'; error?: string }>;
    peers(): Promise<CliResult>;
    cli(args: string[]): Promise<CliResult>;
    onStatus(handler: (status: CoreStatus) => void): () => void;
    onLog(handler: (entry: CoreLogEntry) => void): () => void;
  };
}

declare global {
  interface Window {
    mclink: MclinkBridge;
  }
}

export {};
