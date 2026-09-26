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
  /** 可执行文件路径与其所在目录：自动提权失败时，引导用户"右键 → 以管理员身份运行" */
  exePath?: string;
  exeDir?: string;
  /** 启动时是否自动请求管理员权限（默认 true） */
  autoElevate: boolean;
  /** 关闭窗口时的行为：ask（默认）/ tray / quit */
  closeAction?: CloseAction;
  /** true = 正在用软件渲染（此前观测到 GPU 进程异常，或设了 MCLINK_DISABLE_GPU=1） */
  softwareRendering?: boolean;
  hostname: string;
}

/** 关闭窗口时的行为：询问 / 最小化到托盘 / 彻底退出 */
export type CloseAction = 'ask' | 'tray' | 'quit';

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
  info(): Promise<AppInfo>;
  freePort(): Promise<number>;
  /**
   * TCP 延迟探测（tcping，建房页选节点用）：对每个中继的链接端口做一次 TCP 握手，
   * 返回 `{ "host:port": 最小时延 ms | null }`，超时或连不上是 null。
   *
   * 为什么不是 ICMP：量的是**真正要走的那个端口**，"连不上"因此基本等于"用不了"。
   * 但仍然**只用于展示与排序** —— 单次超时可能只是抖动，不该让节点从选单里消失。
   */
  tcping(targets: ProbeTarget[]): Promise<Record<string, number | null>>;
  openPath(target: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  relaunchElevated(): Promise<{ ok: boolean; error?: string }>;
  setAutoElevate(enabled: boolean): Promise<{ ok: boolean; autoElevate: boolean }>;
  /** 设置页里改"关闭窗口时的默认行为" */
  setCloseAction(value: CloseAction): Promise<{ ok: boolean; closeAction: CloseAction }>;
  /** 主进程问"彻底退出还是最小化"时的回调（返回取消订阅的函数） */
  onAskClose(handler: () => void): () => void;
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
   * 窗口是无边框的（frame: false），最小化/最大化/关闭都必须由界面触发。
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
