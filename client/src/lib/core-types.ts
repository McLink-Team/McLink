/** 主进程返回结构的类型（与 electron/main.cjs 保持一致） */

export type CoreState = 'stopped' | 'starting' | 'running' | 'error';

export interface CoreStatus {
  state: CoreState;
  pid: number | null;
  startedAt: string | null;
  lastError: string | null;
  configFile: string | null;
  args: string[];
  rpcPortal: string | null;
  elevated: boolean;
  coreBin: string;
  coreBinExists: boolean;
  cliBinExists: boolean;
}

export interface CoreLogEntry {
  ts: string;
  stream: 'stdout' | 'stderr' | 'info';
  line: string;
}

export interface CliResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}
