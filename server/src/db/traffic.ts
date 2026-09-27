/** 流量样本与审计日志仓储 */
import type { AuditEntry, TrafficPoint, TrafficScope } from '@mclink/shared';
import { Db, nowIso, parseJson } from './index.ts';

export interface TrafficRow {
  id: number;
  ts: string;
  scope: string;
  scope_id: string;
  room_id: string | null;
  rx_bytes: number;
  tx_bytes: number;
  rx_bps: number;
  tx_bps: number;
  peers: number;
}

export class TrafficRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  record(input: {
    scope: TrafficScope;
    scopeId: string;
    roomId?: string | null;
    rxBytes: number;
    txBytes: number;
    rxBps: number;
    txBps: number;
    peers: number;
  }): void {
    this.db.run(
      `insert into traffic_samples (ts, scope, scope_id, room_id, rx_bytes, tx_bytes, rx_bps, tx_bps, peers)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      nowIso(),
      input.scope,
      input.scopeId,
      input.roomId ?? null,
      Math.round(input.rxBytes),
      Math.round(input.txBytes),
      Math.round(input.rxBps),
      Math.round(input.txBps),
      Math.round(input.peers),
    );
  }

  /** 批量写入，减少事务开销 */
  recordMany(items: Array<Parameters<TrafficRepo['record']>[0]>): void {
    if (items.length === 0) return;
    this.db.transaction(() => {
      for (const item of items) this.record(item);
    });
  }

  series(scope: TrafficScope, scopeId: string, sinceIso: string, limit = 240): TrafficPoint[] {
    const rows = this.db.all<TrafficRow>(
      `select * from traffic_samples where scope = ? and scope_id = ? and ts >= ?
       order by ts desc limit ?`,
      scope,
      scopeId,
      sinceIso,
      limit,
    );
    return rows
      .reverse()
      .map((r) => ({ ts: r.ts, rxBps: r.rx_bps, txBps: r.tx_bps }));
  }

  /**
   * 平台总收发曲线。
   *
   * 优先取 scope='platform'（**全网聚合**：主控中继 + 所有在线子节点）——
   * 玩家按区域就近接入，流量大头在子节点上，只画主控那条线会长期是 0（线上实测）。
   * 升级前的库里只有 scope='relay'，此时退回它，免得曲线突然空掉（代价是那一段只有主控的数）。
   */
  platformSeries(sinceIso: string, limit = 240): TrafficPoint[] {
    const query = (scope: string): Array<{ ts: string; rx: number; tx: number }> =>
      this.db.all<{ ts: string; rx: number; tx: number }>(
        `select ts, sum(rx_bps) as rx, sum(tx_bps) as tx
         from traffic_samples
         where scope = ? and ts >= ?
         group by ts order by ts desc limit ?`,
        scope,
        sinceIso,
        limit,
      );

    const rows = query('platform');
    const effective = rows.length > 0 ? rows : query('relay');
    return effective.reverse().map((r) => ({ ts: r.ts, rxBps: Number(r.rx), txBps: Number(r.tx) }));
  }

  /** 区间累加字节数（按 scope） */
  totalsSince(scope: TrafficScope, scopeId: string, sinceIso: string): { rxBytes: number; txBytes: number } {
    const row = this.db.get<{ rx: number; tx: number }>(
      `select max(rx_bytes) as rx, max(tx_bytes) as tx from traffic_samples
       where scope = ? and scope_id = ? and ts >= ?`,
      scope,
      scopeId,
      sinceIso,
    );
    return { rxBytes: Number(row?.rx ?? 0), txBytes: Number(row?.tx ?? 0) };
  }

  /** 最近 N 个采样里的最新一条 */
  latest(scope: TrafficScope, scopeId: string): TrafficPoint | null {
    const row = this.db.get<TrafficRow>(
      'select * from traffic_samples where scope = ? and scope_id = ? order by ts desc limit 1',
      scope,
      scopeId,
    );
    if (!row) return null;
    return { ts: row.ts, rxBps: row.rx_bps, txBps: row.tx_bps };
  }

  /**
   * 分批删除过期采样。
   *
   * 为什么不能是一条 `delete from traffic_samples where ts < ?`：
   * 这里是同步 SQLite（node:sqlite 的 DatabaseSync），一条大 DELETE 会把整个
   * Node 事件循环按住。采样每 5 秒写一条、还分 4 个维度（relay/platform/room/node），
   * 长期跑的库一次要删几十万行 —— 期间主控**连 TCP 都不应答**（内核 accept 队列满、
   * SYN 被丢），nginx 日志表现为
   *   `upstream timed out (110: Connection timed out) while connecting to upstream`
   * 而且心跳、静态资源一起挂 —— 线上实测就是这个现象，不是某个接口慢。
   *
   * 改成按 rowid 一批批删，调用方在批与批之间让出事件循环（见 index.ts 的 purgeOldData）。
   */
  pruneBatch(keepHours = 72, limit = 5000): number {
    const cutoff = new Date(Date.now() - keepHours * 3600 * 1000).toISOString();
    const res = this.db.run(
      `delete from traffic_samples
        where rowid in (select rowid from traffic_samples where ts < ? limit ?)`,
      cutoff,
      limit,
    );
    return Number(res.changes ?? 0);
  }

  /** 单批删除（保留给脚本与小库调用；定时清理走 pruneBatch 循环） */
  prune(keepHours = 72): number {
    return this.pruneBatch(keepHours);
  }

  /* 「今日累计」以前实现在这里（对采样表取 max），现在由 TrafficLedgerRepo 负责： */

}

/* ------------------------------------------------------------------ 账本 */

export type LedgerScope = 'platform' | 'room' | 'node' | 'user';

export interface LedgerDelta {
  scope: LedgerScope;
  scopeId: string;
  roomId?: string | null;
  userId?: string | null;
  nodeId?: string | null;
  rxBytes: number;
  txBytes: number;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 本地时间的分钟桶，如 `2026-09-28T01:07` —— 与界面上「自然日」的口径一致 */
export function localBucket(at: Date = new Date()): string {
  return `${localDay(at)}T${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/** 本地时间的日期，如 `2026-09-28` */
export function localDay(at: Date = new Date()): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

/**
 * 流量账本：按分钟桶累加**增量**，支持按维度/按天求和。
 *
 * 与 `TrafficRepo` 的分工（别混用）：
 *   · `TrafficRepo`（traffic_samples）= 瞬时速率曲线，5 秒一条、只留 72 小时；
 *   · `TrafficLedgerRepo`（traffic_ledger）= 字节账本，分钟桶累加、留 400 天，
 *     「今日/本月/累计」与按用户/按房间的总量都只认它。
 */
export class TrafficLedgerRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** 累加一批增量（同一事务；桶由当前时间决定，调用方不必传） */
  addMany(items: readonly LedgerDelta[], at: Date = new Date()): void {
    const rows = items.filter((it) => it.rxBytes !== 0 || it.txBytes !== 0);
    if (rows.length === 0) return;
    const bucket = localBucket(at);
    const day = localDay(at);
    const ts = nowIso();
    this.db.transaction(() => {
      for (const it of rows) {
        this.db.run(
          `insert into traffic_ledger (bucket, day, scope, scope_id, room_id, user_id, node_id, rx_bytes, tx_bytes, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(bucket, scope, scope_id) do update set
             rx_bytes = rx_bytes + excluded.rx_bytes,
             tx_bytes = tx_bytes + excluded.tx_bytes,
             room_id = coalesce(excluded.room_id, traffic_ledger.room_id),
             user_id = coalesce(excluded.user_id, traffic_ledger.user_id),
             node_id = coalesce(excluded.node_id, traffic_ledger.node_id),
             updated_at = excluded.updated_at`,
          bucket,
          day,
          it.scope,
          it.scopeId,
          it.roomId ?? null,
          it.userId ?? null,
          it.nodeId ?? null,
          Math.round(it.rxBytes),
          Math.round(it.txBytes),
          ts,
        );
      }
    });
  }

  /** 区间求和：`sinceDay` / `untilDay` 都是本地日期（含端点） */
  sum(filter: { scope: LedgerScope; scopeId?: string; sinceDay?: string; untilDay?: string }): {
    rxBytes: number;
    txBytes: number;
  } {
    const where = ['scope = ?'];
    const params: unknown[] = [filter.scope];
    if (filter.scopeId) {
      where.push('scope_id = ?');
      params.push(filter.scopeId);
    }
    if (filter.sinceDay) {
      where.push('day >= ?');
      params.push(filter.sinceDay);
    }
    if (filter.untilDay) {
      where.push('day <= ?');
      params.push(filter.untilDay);
    }
    const row = this.db.get<{ rx: number; tx: number }>(
      `select coalesce(sum(rx_bytes), 0) as rx, coalesce(sum(tx_bytes), 0) as tx
       from traffic_ledger where ${where.join(' and ')}`,
      ...params,
    );
    return { rxBytes: Number(row?.rx ?? 0), txBytes: Number(row?.tx ?? 0) };
  }

  /** 按 scope_id 分组求和（今日的房间/节点/用户明细用） */
  byScope(filter: { scope: LedgerScope; sinceDay?: string; limit?: number }): Array<{
    scopeId: string;
    roomId: string | null;
    userId: string | null;
    nodeId: string | null;
    rxBytes: number;
    txBytes: number;
  }> {
    const where = ['scope = ?'];
    const params: unknown[] = [filter.scope];
    if (filter.sinceDay) {
      where.push('day >= ?');
      params.push(filter.sinceDay);
    }
    const rows = this.db.all<{
      scope_id: string;
      room_id: string | null;
      user_id: string | null;
      node_id: string | null;
      rx: number;
      tx: number;
    }>(
      `select scope_id,
              max(room_id) as room_id, max(user_id) as user_id, max(node_id) as node_id,
              coalesce(sum(rx_bytes), 0) as rx, coalesce(sum(tx_bytes), 0) as tx
       from traffic_ledger where ${where.join(' and ')}
       group by scope_id
       order by (sum(rx_bytes) + sum(tx_bytes)) desc
       limit ?`,
      ...params,
      Math.min(Math.max(filter.limit ?? 100, 1), 1000),
    );
    return rows.map((r) => ({
      scopeId: r.scope_id,
      roomId: r.room_id,
      userId: r.user_id,
      nodeId: r.node_id,
      rxBytes: Number(r.rx),
      txBytes: Number(r.tx),
    }));
  }

  /**
   * 逐日字节总量（含没有流量的日子补 0）—— 给「近 N 天」柱状图用。
   * 补 0 在 SQL 里很别扭，这里在内存里补齐：天数上限 366，代价可以忽略。
   */
  daySeries(days: number, scope: LedgerScope = 'platform', scopeId = 'all'): Array<{
    day: string;
    rxBytes: number;
    txBytes: number;
  }> {
    const span = Math.min(Math.max(Math.round(days), 1), 366);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (span - 1));
    const rows = this.db.all<{ day: string; rx: number; tx: number }>(
      `select day, coalesce(sum(rx_bytes), 0) as rx, coalesce(sum(tx_bytes), 0) as tx
       from traffic_ledger where scope = ? and scope_id = ? and day >= ?
       group by day`,
      scope,
      scopeId,
      localDay(start),
    );
    const map = new Map(rows.map((r) => [r.day, r]));
    const out: Array<{ day: string; rxBytes: number; txBytes: number }> = [];
    for (let i = 0; i < span; i += 1) {
      const at = new Date(start);
      at.setDate(start.getDate() + i);
      const key = localDay(at);
      const hit = map.get(key);
      out.push({ day: key, rxBytes: Number(hit?.rx ?? 0), txBytes: Number(hit?.tx ?? 0) });
    }
    return out;
  }

  /** 分钟桶序列（字节口径），给流量页画"每分钟走了多少字节" */
  bucketSeries(filter: { scope: LedgerScope; scopeId?: string; sinceBucket: string; limit?: number }): Array<{
    bucket: string;
    rxBytes: number;
    txBytes: number;
  }> {
    const where = ['scope = ?', 'bucket >= ?'];
    const params: unknown[] = [filter.scope, filter.sinceBucket];
    if (filter.scopeId) {
      where.push('scope_id = ?');
      params.push(filter.scopeId);
    }
    const rows = this.db.all<{ bucket: string; rx: number; tx: number }>(
      `select bucket, coalesce(sum(rx_bytes), 0) as rx, coalesce(sum(tx_bytes), 0) as tx
       from traffic_ledger where ${where.join(' and ')}
       group by bucket order by bucket desc limit ?`,
      ...params,
      Math.min(Math.max(filter.limit ?? 240, 1), 2000),
    );
    return rows
      .reverse()
      .map((r) => ({ bucket: r.bucket, rxBytes: Number(r.rx), txBytes: Number(r.tx) }));
  }

  /** 最近一条账本时间（用来判断账本是否在正常增长） */
  lastBucket(): string | null {
    const row = this.db.get<{ bucket: string }>('select max(bucket) as bucket from traffic_ledger');
    return row?.bucket ?? null;
  }

  /** 分批清理过期账本（保留默认 400 天，按天删、批间让出事件循环） */
  pruneBatch(keepDays = 400, limit = 2000): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - Math.max(keepDays, 1));
    const res = this.db.run(
      `delete from traffic_ledger where rowid in (
         select rowid from traffic_ledger where day < ? limit ?
       )`,
      localDay(cutoff),
      limit,
    );
    return Number(res.changes ?? 0);
  }
}

export interface AuditRow {
  id: number;
  ts: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: string | null;
  ip: string | null;
}

export class AuditRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  write(input: {
    actorType: 'user' | 'admin' | 'node' | 'system';
    actorId?: string | null;
    actorName?: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    detail?: Record<string, unknown> | null;
    ip?: string | null;
  }): void {
    this.db.run(
      `insert into audit_log (ts, actor_type, actor_id, actor_name, action, target_type, target_id, detail, ip)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      nowIso(),
      input.actorType,
      input.actorId ?? null,
      input.actorName ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.detail ? JSON.stringify(input.detail) : null,
      input.ip ?? null,
    );
  }

  list(filter: { action?: string; actorId?: string; limit?: number; offset?: number } = {}): {
    rows: AuditEntry[];
    total: number;
  } {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const where: string[] = ['1 = 1'];
    const params: unknown[] = [];
    if (filter.action) {
      where.push('action like ?');
      params.push(`${filter.action}%`);
    }
    if (filter.actorId) {
      where.push('actor_id = ?');
      params.push(filter.actorId);
    }
    const clause = where.join(' and ');
    const rows = this.db.all<AuditRow>(
      `select * from audit_log where ${clause} order by id desc limit ? offset ?`,
      ...params,
      limit,
      offset,
    );
    const total = Number(
      this.db.scalar<number>(`select count(*) as c from audit_log where ${clause}`, ...params) ?? 0,
    );
    return { rows: rows.map(mapAudit), total };
  }

  recent(limit = 20): AuditEntry[] {
    return this.db
      .all<AuditRow>('select * from audit_log order by id desc limit ?', limit)
      .map(mapAudit);
  }
}

function mapAudit(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    ts: row.ts,
    actorType: row.actor_type as AuditEntry['actorType'],
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    detail: parseJson<Record<string, unknown> | null>(row.detail, null),
    ip: row.ip,
  };
}
