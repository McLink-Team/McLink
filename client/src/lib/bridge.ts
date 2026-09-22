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
  /** 启动时是否自动请求管理员权限（默认 true） */
  autoElevate: boolean;
  hostname: string;
}

export interface MclinkBridge {
  info(): Promise<AppInfo>;
  freePort(): Promise<number>;
  openPath(target: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  relaunchElevated(): Promise<{ ok: boolean; error?: string }>;
  setAutoElevate(enabled: boolean): Promise<{ ok: boolean; autoElevate: boolean }>;
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
