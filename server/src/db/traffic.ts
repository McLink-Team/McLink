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

  /** 全平台时间序列：把同一时刻各 scope 的速率相加 */
  platformSeries(sinceIso: string, limit = 240): TrafficPoint[] {
    const rows = this.db.all<{ ts: string; rx: number; tx: number }>(
      `select ts, sum(rx_bps) as rx, sum(tx_bps) as tx
       from traffic_samples
       where scope = 'relay' and ts >= ?
       group by ts order by ts desc limit ?`,
      sinceIso,
      limit,
    );
    return rows.reverse().map((r) => ({ ts: r.ts, rxBps: Number(r.rx), txBps: Number(r.tx) }));
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

  prune(keepHours = 72): number {
    const cutoff = new Date(Date.now() - keepHours * 3600 * 1000).toISOString();
    const res = this.db.run('delete from traffic_samples where ts < ?', cutoff);
    return Number(res.changes ?? 0);
  }

  /** 今日累计流量（用于仪表盘） */
  todayTotals(): { rxBytes: number; txBytes: number } {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const row = this.db.get<{ rx: number; tx: number }>(
      `select max(rx_bytes) as rx, max(tx_bytes) as tx from traffic_samples
       where scope = 'relay' and ts >= ?`,
      startOfDay.toISOString(),
    );
    return { rxBytes: Number(row?.rx ?? 0), txBytes: Number(row?.tx ?? 0) };
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
