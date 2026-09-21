/**
 * SQLite 访问层。
 *
 * 用 Node 24 内置的 `node:sqlite`（同步 API），好处是零原生依赖：
 * 不需要 node-gyp/MSVC，Debian 上也不需要 apt 装编译工具链。
 * 同步调用在本项目的数据量级（百级房间、千级节点）下完全够用，
 * 且避免了异步事务的竞态。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './schema.ts';

export type Row = Record<string, unknown>;

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export class Db {
  readonly #db: DatabaseSync;
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec('pragma journal_mode = WAL');
    this.#db.exec('pragma foreign_keys = ON');
    this.#db.exec('pragma busy_timeout = 5000');
    this.#db.exec('pragma synchronous = NORMAL');
    this.migrate();
  }

  /** 顺序执行未应用的迁移，用 PRAGMA user_version 记录进度 */
  migrate(): void {
    const current = this.userVersion();
    for (let i = current; i < MIGRATIONS.length; i += 1) {
      const sql = MIGRATIONS[i];
      if (!sql) continue;
      this.transaction(() => {
        this.#db.exec(sql);
      });
      this.#db.exec(`pragma user_version = ${i + 1}`);
    }
  }

  userVersion(): number {
    const row = this.#db.prepare('pragma user_version').get() as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  run(sql: string, ...params: unknown[]): RunResult {
    const stmt = this.#db.prepare(sql);
    const res = stmt.run(...(params as never[]));
    return { changes: res.changes, lastInsertRowid: res.lastInsertRowid };
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    const stmt = this.#db.prepare(sql);
    return stmt.get(...(params as never[])) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    const stmt = this.#db.prepare(sql);
    return stmt.all(...(params as never[])) as T[];
  }

  /** 取单列单值 */
  scalar<T = number>(sql: string, ...params: unknown[]): T | undefined {
    const row = this.get<Row>(sql, ...params);
    if (!row) return undefined;
    const values = Object.values(row);
    return values[0] as T | undefined;
  }

  /** 同步事务；回调抛错则整体回滚 */
  transaction<T>(fn: () => T): T {
    this.#db.exec('begin immediate');
    try {
      const out = fn();
      this.#db.exec('commit');
      return out;
    } catch (err) {
      try {
        this.#db.exec('rollback');
      } catch {
        /* 回滚失败时保留原始异常 */
      }
      throw err;
    }
  }

  close(): void {
    try {
      this.#db.close();
    } catch {
      /* 关闭失败无需处理 */
    }
  }
}

/* --------------------------------------------------------------- 工具函数 */

/** SQLite 没有布尔类型，统一用 0/1 存取 */
export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

export function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

/** JSON 列的安全解析 */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 用于 WHERE IN (...) 的占位符 */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}
