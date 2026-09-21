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

export class Logger {
  #level: LogLevel;
  #json: boolean;
  #scope: string;

  constructor(level: LogLevel, scope = 'mclink', json = false) {
    this.#level = level;
    this.#scope = scope;
    this.#json = json;
  }

  child(scope: string): Logger {
    return new Logger(this.#level, `${this.#scope}:${scope}`, this.#json);
  }

  setLevel(level: LogLevel): void {
    this.#level = level;
  }

  get level(): LogLevel {
    return this.#level;
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
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.#level]) return;

    if (this.#json) {
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
  root = new Logger(level, 'mclink', json);
  return root;
}

export function logger(scope?: string): Logger {
  const base = root ?? initLogger('info');
  return scope ? base.child(scope) : base;
}
