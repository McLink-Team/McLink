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
  hostname: string;
}

export interface MclinkBridge {
  info(): Promise<AppInfo>;
  freePort(): Promise<number>;
  openPath(target: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  relaunchElevated(): Promise<{ ok: boolean; error?: string }>;
  confirm(payload: { title?: string; message?: string; detail?: string }): Promise<boolean>;
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
