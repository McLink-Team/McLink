/**
 * 极简结构化日志器。
 *
 * 生产用 JSON 行（便于 journald / Loki 采集），开发用带颜色的人类可读格式。
 */
import type { LogLevel } from './config.ts';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

export interface LogFields {
  [key: string]: unknown;
}

/**
 * 全局日志配置，所有 logger（包括早就发出去的 child）都读这一份。
 *
 * 为什么不是每个 logger 抄一份：`logger('main')` / `logger('server')` 这类调用发生在
 * **模块加载时**，早于 createApp() 里的 initLogger —— 抄一份的话，主控里最常用的
 * 这几个 scope 会一直用着"默认 info + 非 JSON"的旧值。实测后果有两个：
 *   · `MCLINK_LOG_LEVEL=debug` 对这些 scope 调不动（请求日志是 debug 级，直接被吞）；
 *   · 生产环境日志一半 JSON、一半彩色文本，采集端解析不了。
 */
const sink: { level: LogLevel; json: boolean } = { level: 'info', json: false };

export class Logger {
  readonly #scope: string;

  constructor(scope = 'mclink') {
    this.#scope = scope;
  }

  child(scope: string): Logger {
    return new Logger(`${this.#scope}:${scope}`);
  }

  /** 改全局级别（所有 scope 立即生效） */
  setLevel(level: LogLevel): void {
    sink.level = level;
  }

  get level(): LogLevel {
    return sink.level;
  }

  debug(msg: string, fields?: LogFields): void {
    this.#write('debug', msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.#write('info', msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.#write('warn', msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.#write('error', msg, fields);
  }

  #write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[sink.level]) return;

    if (sink.json) {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        scope: this.#scope,
        msg,
        ...fields,
      });
      process.stdout.write(`${line}\n`);
      return;
    }

    const ts = new Date().toISOString().slice(11, 23);
    const tag = level.toUpperCase().padEnd(5);
    const prefix = `${COLORS[level]}${ts} ${tag}${RESET} ${this.#scope} ${msg}`;
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${formatFields(fields)}` : '';
    process.stdout.write(`${prefix}${suffix}\n`);
  }
}

function formatFields(fields: LogFields): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v instanceof Error) {
      parts.push(`${k}=${v.message}`);
      continue;
    }
    if (typeof v === 'object') {
      try {
        parts.push(`${k}=${JSON.stringify(v)}`);
      } catch {
        parts.push(`${k}=<unserializable>`);
      }
      continue;
    }
    parts.push(`${k}=${String(v)}`);
  }
  return parts.join(' ');
}

let root: Logger | null = null;

export function initLogger(level: LogLevel, json = false): Logger {
  sink.level = level;
  sink.json = json;
  root ??= new Logger();
  return root;
}

export function logger(scope?: string): Logger {
  const base = root ?? initLogger('info');
  return scope ? base.child(scope) : base;
}
