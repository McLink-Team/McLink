/** 子节点（区域中继）仓储 */
import type { NodeStatus, RelayNode } from '@mclink/shared';
import { Db, nowIso, parseJson, toBool, placeholders } from './index.ts';

export interface NodeRow {
  id: string;
  name: string;
  region: string;
  endpoint: string;
  /** 运行端口：子节点 easytier-core 实际 bind 的端口（NAT 后可不同于链接端口） */
  listen_port: number | null;
  /** 链接端口：主控下发给客户端连接用的端口 */
  connect_port: number | null;
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

/**
 * endpoint 的端口部分。
 * 数据是 `host:port`（注册时校验过），拿不到就返回 null 让上层回退到默认端口。
 */
export function endpointPort(endpoint: string): number | null {
  const raw = endpoint.slice(endpoint.lastIndexOf(':') + 1);
  const port = Number.parseInt(raw, 10);
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : null;
}

/** endpoint 的主机部分（`host:port` → `host`） */
export function endpointHost(endpoint: string): string {
  const index = endpoint.lastIndexOf(':');
  return index > 0 ? endpoint.slice(0, index) : endpoint;
}

/**
 * 运行端口：节点上 easytier-core 实际监听的端口。
 * 回退：显式的 listen_port → endpoint 的端口 → 调用方给的默认值。
 *
 * 这三个函数刻意放在仓储层而不是服务层：房间服务（生成客户端票据）与节点服务
 * （生成节点配置）都要用同一个规则，而它们之间不该互相依赖。
 */
export function nodeListenPort(row: NodeRow, fallback: number): number {
  return row.listen_port ?? endpointPort(row.endpoint) ?? fallback;
}

/** 链接端口：主控下发给客户端、用来连这个节点的端口 */
export function nodeConnectPort(row: NodeRow, fallback: number): number {
  return row.connect_port ?? endpointPort(row.endpoint) ?? fallback;
}

/**
 * 下发给客户端的中继地址 `host:connectPort`。
 * 用这个而不是直接拼 row.endpoint：管理员改过链接端口后，老的 endpoint 字符串
 * 会立刻过期，票据必须按**当前**端口生成。
 */
export function nodeClientEndpoint(row: NodeRow, fallback: number): string {
  return `${endpointHost(row.endpoint)}:${nodeConnectPort(row, fallback)}`;
}

export function toNode(row: NodeRow): RelayNode {
  const fallback = endpointPort(row.endpoint);
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    endpoint: row.endpoint,
    listenPort: row.listen_port ?? fallback,
    connectPort: row.connect_port ?? fallback,
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
    listenPort: number;
    connectPort: number;
    tokenHash: string;
    capacityPeers: number;
    version?: string | null;
    tags?: string[];
    weight?: number;
    status?: NodeStatus;
  }): NodeRow {
    this.db.run(
      `insert into relay_nodes (id, name, region, endpoint, listen_port, connect_port, public_ip, status, version,
        capacity_peers, peers, rooms, rx_bps, tx_bps, weight, tags, token_hash, last_seen_at, created_at, disabled, config_revision)
       values (?, ?, ?, ?, ?, ?, null, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, null, ?, 0, 0)`,
      input.id,
      input.name,
      input.region,
      input.endpoint,
      input.listenPort,
      input.connectPort,
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
    fields: {
      name?: string;
      region?: string;
      endpoint?: string;
      listenPort?: number;
      connectPort?: number;
      weight?: number;
      capacityPeers?: number;
      tags?: string[];
    },
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
    if (fields.listenPort !== undefined) {
      sets.push('listen_port = ?');
      params.push(fields.listenPort);
    }
    if (fields.connectPort !== undefined) {
      sets.push('connect_port = ?');
      params.push(fields.connectPort);
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

  /**
   * 所有**在线**子节点的速率与承载之和。
   *
   * 为什么只算 online/degraded：离线节点表里还留着最后上报的 bps，
   * 算进"全网实时收发"会让读数永远回不到 0（节点掉线了数字还是热的）。
   *
   * 平台维度的读数（落地页「中继收发」、仪表盘、流量页）拿它加上主控中继自身的量 ——
   * 玩家按区域就近接入，流量大头其实在子节点上，只报主控会长期是 0。
   */
  totalBps(): { rxBps: number; txBps: number; peers: number; nodes: number } {
    const online = this.list().filter((n) => n.status === 'online' || n.status === 'degraded');
    return {
      rxBps: online.reduce((acc, n) => acc + n.rx_bps, 0),
      txBps: online.reduce((acc, n) => acc + n.tx_bps, 0),
      peers: online.reduce((acc, n) => acc + n.peers, 0),
      nodes: online.length,
    };
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
