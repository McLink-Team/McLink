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
import { logger } from '../logger.ts';

const log = logger('db');

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
    /**
     * 页缓存 64MB（SQLite 默认只有 2MB）。
     * 实测（500 万行 / 727MB 的库）：一次 512 房间的心跳中位 24.9ms → 9.6ms。
     * 代价是常驻内存 +64MB，可以随时回滚这两行。
     */
    this.#db.exec('pragma cache_size = -65536');
    /** mmap 256MB：读走内存映射，省掉一轮页拷贝（库小于该值时按库大小映射） */
    this.#db.exec('pragma mmap_size = 268435456');
    /**
     * WAL 自动 checkpoint 阈值（单位：页；SQLite 默认 1000 页 ≈ 4MB）。
     *
     * 特意调大：checkpoint 会在**触发它的那一次写入调用里同步做完**（写主库 + fsync），
     * 默认阈值下任何一次 `db.run()` 都可能突然多花几十到几百毫秒 ——
     * 单线程主控在这段时间里连新 TCP 连接都排不进 accept 队列，
     * nginx 侧就会报 `upstream timed out (110) while connecting to upstream`
     * （线上实测到过这个现象，WAL 文件也长期卡在阈值附近：主库 3.2MB / WAL 3.95MB）。
     * 调到 10000 页（≈40MB）后，代价是 WAL 会短暂涨到几十 MB（崩溃恢复多回放一点，可接受），
     * 换来的是不再在请求路径里随机卡顿；真正的 checkpoint 交给维护窗口的 checkpoint()。
     */
    this.#db.exec('pragma wal_autocheckpoint = 10000');
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

  /**
   * prepared statement 缓存。
   *
   * `DatabaseSync.prepare()` 每次都要重新解析 SQL 并编译。实测在 512 行/批的写入路径上，
   * 复用语句比每次 prepare 快 **2.3 倍**（32.8k → 76.4k 行/秒）。
   * 语句对象无状态（参数每调用传入），缓存安全；容量给 512 —— 本项目语句总数远小于它，
   * 等于全缓存，万一到顶就整体清空重来（最坏退化成原来的行为）。
   */
  readonly #stmts = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  #stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    let stmt = this.#stmts.get(sql);
    if (!stmt) {
      if (this.#stmts.size >= 512) this.#stmts.clear();
      stmt = this.#db.prepare(sql);
      this.#stmts.set(sql, stmt);
    }
    return stmt;
  }

  run(sql: string, ...params: unknown[]): RunResult {
    return this.#timed(sql, () => {
      const res = this.#stmt(sql).run(...(params as never[]));
      return { changes: res.changes, lastInsertRowid: res.lastInsertRowid };
    });
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.#timed(sql, () => this.#stmt(sql).get(...(params as never[])) as T | undefined);
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.#timed(sql, () => this.#stmt(sql).all(...(params as never[])) as T[]);
  }

  /** 取单列单值 */
  scalar<T = number>(sql: string, ...params: unknown[]): T | undefined {
    const row = this.get<Row>(sql, ...params);
    if (!row) return undefined;
    const values = Object.values(row);
    return values[0] as T | undefined;
  }

  /**
   * 单条语句超过这个毫秒数就打日志（0 = 关闭）。
   *
   * 存在的意义只有一个：线上出现"主控突然几十秒不应答"时，日志里能直接看到
   * 是哪条 SQL 卡住了事件循环 —— 否则只能靠猜（本项目的 IPC/HTTP 兜底看门狗
   * 只能告诉你"请求没返回"，看不到原因）。
   */
  readonly slowMs = Number(process.env.MCLINK_SLOW_SQL_MS ?? 200);

  #timed<T>(sql: string, fn: () => T): T {
    if (!(this.slowMs > 0)) return fn();
    const started = Date.now();
    const out = fn();
    const ms = Date.now() - started;
    if (ms >= this.slowMs) {
      log.warn('SQLite 语句偏慢（事件循环在这段时间被占住）', {
        ms,
        sql: sql.replace(/\s+/g, ' ').trim().slice(0, 120),
      });
    }
    return out;
  }

  /**
   * 显式 checkpoint（默认 TRUNCATE：做完把 WAL 文件截断）。
   *
   * **只在维护窗口调用**：它会同步写主库并 fsync，期间事件循环被占住。
   * 返回值用于确认"这一次到底卡了多久、有多少页要写"。
   */
  checkpoint(mode: 'PASSIVE' | 'TRUNCATE' = 'TRUNCATE'): { ms: number; busy: number; log: number; checkpointed: number } {
    const started = Date.now();
    const row = this.#db.prepare(`pragma wal_checkpoint(${mode})`).get() as
      | { busy?: number | bigint; log?: number | bigint; checkpointed?: number | bigint }
      | undefined;
    return {
      ms: Date.now() - started,
      busy: Number(row?.busy ?? 0),
      log: Number(row?.log ?? 0),
      checkpointed: Number(row?.checkpointed ?? 0),
    };
  }

  /**
   * 事务嵌套深度。嵌套调用**并入外层事务**。
   *
   * SQLite 不支持嵌套 `begin`（会直接报 "cannot start a transaction within a transaction"），
   * 而调用链天然会嵌套：例如 agent 心跳想把自己那 512 次 upsert + recordMany 合成一个事务，
   * 而 recordMany 内部也在开事务。并进来既省掉重复的 begin/commit（少几次 fsync），
   * 也让"顺手把外层包成事务"变成安全的优化手段。
   * 不做 savepoint：这里不需要部分回滚，语义越简单越好。
   */
  #txDepth = 0;

  /** 同步事务；回调抛错则整体回滚。已在事务里时直接并入外层 */
  transaction<T>(fn: () => T): T {
    if (this.#txDepth > 0) return fn();
    this.#db.exec('begin immediate');
    this.#txDepth += 1;
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
    } finally {
      this.#txDepth -= 1;
    }
  }

  close(): void {
    // 先放掉缓存的语句，避免"关闭时仍有未结束的语句"
    this.#stmts.clear();
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
