/** 子节点（区域中继）仓储 */
import type { NodeStatus, RelayNode } from '@mclink/shared';
import { Db, nowIso, parseJson, toBool, placeholders } from './index.ts';

export interface NodeRow {
  id: string;
  name: string;
  region: string;
  endpoint: string;
  public_ip: string | null;
  status: string;
  version: string | null;
  capacity_peers: number;
  peers: number;
  rooms: number;
  rx_bps: number;
  tx_bps: number;
  weight: number;
  tags: string;
  token_hash: string;
  last_seen_at: string | null;
  created_at: string;
  disabled: number;
  config_revision: number;
}

export function toNode(row: NodeRow): RelayNode {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    endpoint: row.endpoint,
    publicIp: row.public_ip,
    status: row.status as NodeStatus,
    version: row.version,
    capacityPeers: row.capacity_peers,
    peers: row.peers,
    rooms: row.rooms,
    rxBps: row.rx_bps,
    txBps: row.tx_bps,
    weight: row.weight,
    tags: parseJson<string[]>(row.tags, []),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

export class NodeRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  findById(id: string): NodeRow | undefined {
    return this.db.get<NodeRow>('select * from relay_nodes where id = ?', id);
  }

  findByIds(ids: string[]): NodeRow[] {
    if (ids.length === 0) return [];
    return this.db.all<NodeRow>(
      `select * from relay_nodes where id in (${placeholders(ids.length)})`,
      ...ids,
    );
  }

  findByEndpoint(endpoint: string): NodeRow | undefined {
    return this.db.get<NodeRow>('select * from relay_nodes where endpoint = ?', endpoint);
  }

  findByTokenHash(hash: string): NodeRow | undefined {
    return this.db.get<NodeRow>('select * from relay_nodes where token_hash = ?', hash);
  }

  create(input: {
    id: string;
    name: string;
    region: string;
    endpoint: string;
    tokenHash: string;
    capacityPeers: number;
    version?: string | null;
    tags?: string[];
    weight?: number;
    status?: NodeStatus;
  }): NodeRow {
    this.db.run(
      `insert into relay_nodes (id, name, region, endpoint, public_ip, status, version, capacity_peers,
        peers, rooms, rx_bps, tx_bps, weight, tags, token_hash, last_seen_at, created_at, disabled, config_revision)
       values (?, ?, ?, ?, null, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, null, ?, 0, 0)`,
      input.id,
      input.name,
      input.region,
      input.endpoint,
      input.status ?? 'pending',
      input.version ?? null,
      input.capacityPeers,
      input.weight ?? 100,
      JSON.stringify(input.tags ?? []),
      input.tokenHash,
      nowIso(),
    );
    return this.findById(input.id)!;
  }

  updateHeartbeat(
    id: string,
    fields: {
      peers: number;
      rooms: number;
      rxBps: number;
      txBps: number;
      version?: string | null;
      publicIp?: string | null;
    },
  ): void {
    this.db.run(
      `update relay_nodes set peers = ?, rooms = ?, rx_bps = ?, tx_bps = ?, last_seen_at = ?,
         version = coalesce(?, version), public_ip = coalesce(?, public_ip)
       where id = ?`,
      Math.round(fields.peers),
      Math.round(fields.rooms),
      Math.round(fields.rxBps),
      Math.round(fields.txBps),
      nowIso(),
      fields.version ?? null,
      fields.publicIp ?? null,
      id,
    );
  }

  setStatus(id: string, status: NodeStatus): void {
    this.db.run('update relay_nodes set status = ? where id = ?', status, id);
  }

  setDisabled(id: string, disabled: boolean): void {
    this.db.run(
      "update relay_nodes set disabled = ?, status = case when ? = 1 then 'disabled' else 'offline' end where id = ?",
      disabled ? 1 : 0,
      disabled ? 1 : 0,
      id,
    );
  }

  updateMeta(
    id: string,
    fields: { name?: string; region?: string; endpoint?: string; weight?: number; capacityPeers?: number; tags?: string[] },
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.name !== undefined) {
      sets.push('name = ?');
      params.push(fields.name);
    }
    if (fields.region !== undefined) {
      sets.push('region = ?');
      params.push(fields.region);
    }
    if (fields.endpoint !== undefined) {
      sets.push('endpoint = ?');
      params.push(fields.endpoint);
    }
    if (fields.weight !== undefined) {
      sets.push('weight = ?');
      params.push(fields.weight);
    }
    if (fields.capacityPeers !== undefined) {
      sets.push('capacity_peers = ?');
      params.push(fields.capacityPeers);
    }
    if (fields.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(fields.tags));
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db.run(`update relay_nodes set ${sets.join(', ')} where id = ?`, ...params);
  }

  bumpConfigRevision(id: string): number {
    this.db.run('update relay_nodes set config_revision = config_revision + 1 where id = ?', id);
    return Number(this.db.scalar<number>('select config_revision from relay_nodes where id = ?', id) ?? 0);
  }

  delete(id: string): void {
    this.db.run('delete from relay_nodes where id = ?', id);
  }

  list(filter: { region?: string; status?: string; search?: string } = {}): NodeRow[] {
    const where: string[] = ['1 = 1'];
    const params: unknown[] = [];
    if (filter.region) {
      where.push('region = ?');
      params.push(filter.region);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.search) {
      where.push('(name like ? or endpoint like ?)');
      const like = `%${filter.search}%`;
      params.push(like, like);
    }
    return this.db.all<NodeRow>(
      `select * from relay_nodes where ${where.join(' and ')} order by region, name`,
      ...params,
    );
  }

  /** 可供调度的节点：在线、未禁用、权重 > 0、未超容量 */
  listSchedulable(): NodeRow[] {
    return this.db.all<NodeRow>(
      `select * from relay_nodes
       where status in ('online','degraded') and disabled = 0 and weight > 0
       order by weight desc`,
    );
  }

  countByStatus(): Record<string, number> {
    const rows = this.db.all<{ status: string; c: number }>(
      'select status, count(*) as c from relay_nodes group by status',
    );
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = Number(row.c);
    return out;
  }

  count(): number {
    return Number(this.db.scalar<number>('select count(*) as c from relay_nodes') ?? 0);
  }

  /** 把超时未心跳的在线节点标记为离线 */
  markStaleOffline(timeoutSeconds: number): string[] {
    const cutoff = new Date(Date.now() - timeoutSeconds * 1000).toISOString();
    const stale = this.db.all<NodeRow>(
      "select * from relay_nodes where status in ('online','degraded') and (last_seen_at is null or last_seen_at < ?)",
      cutoff,
    );
    if (stale.length === 0) return [];
    this.db.run(
      "update relay_nodes set status = 'offline', peers = 0, rooms = 0, rx_bps = 0, tx_bps = 0 where status in ('online','degraded') and (last_seen_at is null or last_seen_at < ?)",
      cutoff,
    );
    return stale.map((n) => n.id);
  }

  /** 去重的区域列表 */
  regionsInUse(): string[] {
    const rows = this.db.all<{ region: string }>('select distinct region from relay_nodes');
    return rows.map((r) => r.region);
  }
}
