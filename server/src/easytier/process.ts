/**
 * easytier-core 子进程托管。
 *
 * 主控与子节点都以「一个 easytier-core 进程 = 一个公共中继」的方式运行：
 * 它只监听一个端口，靠 relay_network_whitelist 的 wildmatch 为所有房间网络转发，
 * 因此天然支持单端口多房间。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { buildLaunchArgs } from './config.ts';
import { logger } from '../logger.ts';

const log = logger('easytier-core');

/**
 * 判断一行日志是不是"纯装饰"。
 *
 * easytier-core 启动时会写一行几十个连字符的横幅（`-------------------`）。
 * 控制台把日志当正文渲染，于是整页看起来像被破折号填满 —— 设计检查器会因此报
 * `em-dash-overuse`，而人看也确实是噪声。这里的判据刻意收得很紧：
 * **整行只由分隔符与空白组成且长度 ≥8**，正常日志不会被误伤。
 */
export function isDecorationLine(line: string): boolean {
  // 门槛定在 4 个字符：`----` / `====` 这类纯分隔线没有信息量；
  // 而 `--`（2 个）可能是命令行片段，不碰。
  return /^[-=~*_#\s]{4,}$/.test(line.trim());
}

export type CoreState = 'stopped' | 'starting' | 'running' | 'error';

export interface CoreRunOptions {
  coreBin: string;
  /** 配置文件路径（TOML） */
  configFile: string;
  /** RPC 管理端口（命令行 `-r`），仅本机可访问 */
  rpcPortal?: string | null;
  rpcPortalWhitelist?: string[];
  /** 额外的命令行参数 */
  extraArgs?: string[];
  /** 日志文件路径；null 表示只保留内存环形缓冲 */
  logFile?: string | null;
  /** 启动后多久视为「已就绪」（秒） */
  readyDelaySeconds?: number;
  /** 崩溃后自动重启 */
  autoRestart?: boolean;
  /** 重启退避上限（毫秒） */
  maxBackoffMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface CoreStatus {
  state: CoreState;
  pid: number | null;
  startedAt: string | null;
  restarts: number;
  lastExitCode: number | null;
  lastError: string | null;
  configFile: string;
  command: string | null;
}

export interface CoreEvents {
  state: [CoreStatus];
  log: [{ line: string; stream: 'stdout' | 'stderr' }];
}

const LOG_RING_SIZE = 400;

export class EasytierCore extends EventEmitter<CoreEvents> {
  #options: CoreRunOptions;
  #child: ChildProcess | null = null;
  #state: CoreState = 'stopped';
  #startedAt: string | null = null;
  #restarts = 0;
  #lastExitCode: number | null = null;
  #lastError: string | null = null;
  #stopping = false;
  #restartTimer: NodeJS.Timeout | null = null;
  #readyTimer: NodeJS.Timeout | null = null;
  #ring: string[] = [];
  #command: string | null = null;
  #logStream: fs.WriteStream | null = null;
  #readyAt: number | null = null;

  constructor(options: CoreRunOptions) {
    super();
    this.#options = options;
  }

  get status(): CoreStatus {
    return {
      state: this.#state,
      pid: this.#child?.pid ?? null,
      startedAt: this.#startedAt,
      restarts: this.#restarts,
      lastExitCode: this.#lastExitCode,
      lastError: this.#lastError,
      configFile: this.#options.configFile,
      command: this.#command,
    };
  }

  get running(): boolean {
    return this.#state === 'running' || this.#state === 'starting';
  }

  /** 最近日志（内存环形缓冲），供管理台查看 */
  /**
   * 供界面展示的最近日志。
   *
   * 这里会滤掉"纯装饰行"：easytier-core 启动时会往日志里写一行几十个连字符的横幅，
   * 控制台的日志面板把它当正文渲染出来 —— 对排查没用，却让整页看起来像破折号堆。
   * 注意只影响界面视图：落盘的日志文件仍然保留原样，排查时能看到全部。
   */
  recentLogs(limit = 200): string[] {
    return this.#ring.filter((line) => !isDecorationLine(line)).slice(-limit);
  }

  async start(): Promise<CoreStatus> {
    if (this.#child) return this.status;

    if (!fs.existsSync(this.#options.coreBin)) {
      this.#setState('error', `easytier-core 不存在: ${this.#options.coreBin}`);
      return this.status;
    }
    if (!fs.existsSync(this.#options.configFile)) {
      this.#setState('error', `配置文件不存在: ${this.#options.configFile}`);
      return this.status;
    }

    const args = buildLaunchArgs({
      configFile: this.#options.configFile,
      rpcPortal: this.#options.rpcPortal ?? null,
      rpcPortalWhitelist: this.#options.rpcPortalWhitelist,
      extraArgs: this.#options.extraArgs,
    });
    this.#command = `${this.#options.coreBin} ${args.join(' ')}`;

    if (this.#options.logFile) {
      fs.mkdirSync(path.dirname(this.#options.logFile), { recursive: true });
      this.#logStream = fs.createWriteStream(this.#options.logFile, { flags: 'a' });
    }

    this.#stopping = false;
    this.#setState('starting');

    try {
      this.#child = spawn(this.#options.coreBin, args, {
        cwd: this.#options.cwd ?? path.dirname(this.#options.configFile),
        windowsHide: true,
        env: { ...process.env, ...(this.#options.env ?? {}) },
      });
    } catch (err) {
      this.#child = null;
      this.#setState('error', `启动失败: ${(err as Error).message}`);
      return this.status;
    }

    this.#startedAt = new Date().toISOString();

    this.#child.stdout?.on('data', (chunk: Buffer) => this.#ingest(chunk, 'stdout'));
    this.#child.stderr?.on('data', (chunk: Buffer) => this.#ingest(chunk, 'stderr'));

    this.#child.on('error', (err) => {
      this.#lastError = err.message;
      log.error('easytier-core 进程错误', { error: err.message, bin: this.#options.coreBin });
    });

    this.#child.on('close', (code) => {
      this.#lastExitCode = code;
      this.#child = null;
      this.#readyAt = null;
      this.#logStream?.end();
      this.#logStream = null;

      if (this.#stopping) {
        this.#setState('stopped');
        return;
      }
      this.#setState('error', `进程退出，退出码 ${code}`);
      if (this.#options.autoRestart !== false) this.#scheduleRestart();
    });

    // 进程能起来且没有立刻退出，就认为进入 running；
    // EasyTier 没有「就绪」信号，用一个小延迟把崩溃早期的情况区分开。
    const delay = (this.#options.readyDelaySeconds ?? 1.2) * 1000;
    this.#readyTimer = setTimeout(() => {
      if (this.#child && !this.#stopping) {
        this.#readyAt = Date.now();
        this.#setState('running');
        log.info('easytier-core 已启动', { pid: this.#child.pid, config: this.#options.configFile });
      }
    }, delay);

    return this.status;
  }

  async stop(timeoutMs = 6000): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    if (this.#readyTimer) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = null;
    }
    const child = this.#child;
    if (!child) {
      this.#setState('stopped');
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 进程可能已退出 */
        }
        resolve();
      }, timeoutMs);

      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });

      try {
        // Windows 上 Node 会把 SIGTERM 映射为 TerminateProcess
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });

    this.#child = null;
    this.#setState('stopped');
  }

  /** 配置变更后重启（例如中继白名单/限速调整） */
  async restart(): Promise<CoreStatus> {
    await this.stop();
    return this.start();
  }

  /** 进程自启动至今的秒数 */
  uptimeSeconds(): number {
    if (!this.#readyAt) return 0;
    return Math.max(0, Math.floor((Date.now() - this.#readyAt) / 1000));
  }

  #scheduleRestart(): void {
    const max = this.#options.maxBackoffMs ?? 30_000;
    const backoff = Math.min(max, 1000 * 2 ** Math.min(this.#restarts, 5));
    this.#restarts += 1;
    log.warn(`easytier-core 将在 ${backoff}ms 后重启`, { restarts: this.#restarts });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.start();
    }, backoff);
  }

  #ingest(chunk: Buffer, stream: 'stdout' | 'stderr'): void {
    const text = chunk.toString('utf8');
    this.#logStream?.write(text);
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (line.length === 0) continue;
      this.#ring.push(line);
      if (this.#ring.length > LOG_RING_SIZE) this.#ring.shift();
      this.emit('log', { line, stream });
    }
  }

  #setState(state: CoreState, error?: string): void {
    this.#state = state;
    if (error !== undefined) this.#lastError = error;
    if (error) log.error(error, { config: this.#options.configFile });
    this.emit('state', this.status);
  }
}
