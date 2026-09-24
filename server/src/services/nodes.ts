/**
 * 子节点（agent）服务：注册、心跳、健康检查与调度数据维护。
 *
 * 子节点是一台部署在某区域的公共中继。它的角色跟主控中继完全一样
 * （单端口 + relay_network_whitelist 通配），区别只是归属与容量。
 */
import { isKnownRegion, isValidHostPort, kbpsToBytesPerSecond, type RelayNode } from '@mclink/shared';
import {
  NodeRepo,
  endpointPort,
  nodeClientEndpoint,
  nodeConnectPort,
  nodeListenPort,
  toNode,
  type NodeRow,
} from '../db/nodes.ts';
import { EnrollKeyRepo } from '../db/users.ts';
import { AuditRepo } from '../db/traffic.ts';
import { HttpError } from '../util/errors.ts';
import { logger } from '../logger.ts';
import { sha256, shortId, randomBytesBuf } from '../util/id.ts';
import { renderEasytierToml, buildLaunchArgs, rpcPortalForListenPort, CONFIG_PLACEHOLDER } from '../easytier/config.ts';
import type { ServerConfig } from '../config.ts';
import type { SettingsService } from './settings.ts';

const log = logger('nodes');

/** 端口归一化：只接受 1–65535 的整数，其余一律当作"没给" */
export function normalizePort(value: unknown): number | null {
  const port = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return Math.trunc(port);
}

export interface NodeAuthResult {
  node: NodeRow;
}

/** 某个中继来源正在转发的一个房间网络 */
export interface RelayedNetworkSample {
  networkName: string;
  /** 该网络上探测到的 peer 数 */
  peers: number;
  rxBps: number;
  txBps: number;
  rxBytes?: number;
  txBytes?: number;
}

export interface MergedRelayedNetwork {
  networkName: string;
  peers: number;
  rxBps: number;
  txBps: number;
  rxBytes: number;
  txBytes: number;
  /**
   * 有几个中继来源在转发它（主控 + 各子节点，各算 1 个）。
   * 界面上用它区分"只走主控"和"两个区域节点都在带"。
   */
  relaySources: number;
  /** 主控中继是否也在转发它（false 表示只走子节点） */
  onMaster: boolean;
}

/**
 * 按网络名合并「主控 + 子节点」的外来网络列表。
 *
 * 为什么必须合并：玩家是按区域就近接入的，绝大多数房间流量走在子节点上，
 * 只看主控那一台的话，控制台的「外来网络」和流量页的按房间视图会长期是 0 或残缺。
 * 同一个网络被多个来源转发时，peer 数与速率相加、来源计数 +1。
 */
export function mergeRelayedNetworks(
  master: ReadonlyArray<RelayedNetworkSample>,
  nodes: ReadonlyArray<RelayedNetworkSample>,
): MergedRelayedNetwork[] {
  const merged = new Map<string, MergedRelayedNetwork>();
  const add = (item: RelayedNetworkSample, onMaster: boolean): void => {
    const name = item.networkName?.trim();
    if (!name) return;
    const current = merged.get(name);
    if (current) {
      current.peers += Math.max(0, item.peers);
      current.rxBps += Math.max(0, item.rxBps);
      current.txBps += Math.max(0, item.txBps);
      current.rxBytes += Math.max(0, item.rxBytes ?? 0);
      current.txBytes += Math.max(0, item.txBytes ?? 0);
      current.relaySources += 1;
      current.onMaster ||= onMaster;
      return;
    }
    merged.set(name, {
      networkName: name,
      peers: Math.max(0, item.peers),
      rxBps: Math.max(0, item.rxBps),
      txBps: Math.max(0, item.txBps),
      rxBytes: Math.max(0, item.rxBytes ?? 0),
      txBytes: Math.max(0, item.txBytes ?? 0),
      relaySources: 1,
      onMaster,
    });
  };
  for (const item of master) add(item, true);
  for (const item of nodes) add(item, false);
  // 速率高的排前面：控制台的表格按这个顺序看最有用
  return [...merged.values()].sort((a, b) => b.rxBps + b.txBps - (a.rxBps + a.txBps));
}

export class NodeService {
  private readonly config: ServerConfig;
  private readonly nodes: NodeRepo;
  private readonly enrollKeys: EnrollKeyRepo;
  private readonly audit: AuditRepo;
  private readonly settings: SettingsService;
  /**
   * 各子节点当前正在转发的房间网络（内存态，心跳刷新）。
   *
   * 不放数据库：这是"此刻在转发什么"的实时读数，重启后 20 秒内就会被心跳填回来，
   * 落库反而要为它加列、加迁移，还会引入"节点掉线后残留的脏记录"。
   */
  readonly #relaying = new Map<string, { at: number; networks: RelayedNetworkSample[] }>();

  constructor(
    config: ServerConfig,
    nodes: NodeRepo,
    enrollKeys: EnrollKeyRepo,
    audit: AuditRepo,
    settings: SettingsService,
  ) {
    this.config = config;
    this.nodes = nodes;
    this.enrollKeys = enrollKeys;
    this.audit = audit;
    this.settings = settings;
  }

  /* ------------------------------------------------------------ 注册 */

  enroll(input: {
    enrollKey: string;
    name: string;
    region: string;
    endpoint: string;
    /** 运行端口：子节点 easytier-core 实际监听的端口；缺省时与链接端口相同 */
    listenPort?: number;
    /** 链接端口：下发给客户端的端口；缺省时取 endpoint 里的端口 */
    connectPort?: number;
    capacityPeers?: number;
    version?: string | null;
    tags?: string[];
    publicIp?: string | null;
    /** 同一 endpoint 重复上线时，允许用原令牌覆盖（节点重装场景） */
  }): { node: RelayNode; nodeToken: string; relayConfigToml: string; launchArgs: string[]; heartbeatIntervalSeconds: number } {
    const key = this.enrollKeys.find(input.enrollKey.trim().toUpperCase());
    if (!key) throw HttpError.forbidden('注册密钥无效');
    if (key.revoked === 1) throw HttpError.forbidden('注册密钥已被吊销');
    if (key.used_at) throw HttpError.forbidden('注册密钥已被使用');

    if (!isValidHostPort(input.endpoint)) {
      throw HttpError.badRequest('endpoint 格式应为 host:port', { endpoint: '格式应为 host:port' });
    }
    if (!isKnownRegion(input.region)) {
      throw HttpError.badRequest(`未知区域: ${input.region}`, { region: '未知区域' });
    }
    if (this.nodes.findByEndpoint(input.endpoint)) {
      throw HttpError.conflict('该 endpoint 已被其它节点注册');
    }

    // 端口解析：endpoint 里的端口是「链接端口」，运行端口可以单独给（NAT 后面的常见情形）
    const endpointPortValue = endpointPort(input.endpoint);
    const connectPort = normalizePort(input.connectPort) ?? endpointPortValue ?? this.config.easytier.relayPort;
    const listenPort = normalizePort(input.listenPort) ?? connectPort;

    const nodeId = shortId('n');
    /**
     * 节点长期令牌。
     * 必须用 CSPRNG：`Math.random()` 是可预测的 PRNG，拿它当长期凭证的熵源
     * 等于给攻击者留了一条伪造节点身份的路。
     */
    const nodeToken = `${nodeId}.${randomBytesBuf(32).toString('base64url')}`;
    const row = this.nodes.create({
      id: nodeId,
      name: input.name.trim().slice(0, 40),
      region: input.region,
      endpoint: input.endpoint.trim(),
      listenPort,
      connectPort,
      tokenHash: sha256(nodeToken),
      capacityPeers: Math.max(10, input.capacityPeers ?? this.settings.current.defaultCapacityPeers),
      version: input.version ?? null,
      tags: input.tags ?? [],
      status: 'pending',
    });
    this.enrollKeys.markUsed(key.key, nodeId);

    this.audit.write({
      actorType: 'node',
      actorId: nodeId,
      actorName: row.name,
      action: 'node.enroll',
      targetType: 'node',
      targetId: nodeId,
      detail: { region: row.region, endpoint: row.endpoint, listenPort, connectPort },
    });
    log.info('子节点已注册，等待管理员启用', {
      node: nodeId,
      name: row.name,
      region: row.region,
      listenPort,
      connectPort,
    });

    return {
      node: toNode(row),
      nodeToken,
      relayConfigToml: this.renderNodeConfig(row),
      launchArgs: this.launchArgsFor(row),
      heartbeatIntervalSeconds: this.config.nodeHeartbeatIntervalSeconds,
    };
  }

  /** 生成子节点应运行的 EasyTier 配置 */
  renderNodeConfig(row: NodeRow): string {
    const et = this.config.easytier;
    const port = this.listenPortOf(row);
    const s = this.settings.current;
    return renderEasytierToml({
      instanceName: `mclink-node-${row.id}`,
      hostname: row.name,
      dhcp: true,
      listeners: [`tcp://0.0.0.0:${port}`, `udp://0.0.0.0:${port}`],
      peers: [],
      networkName: `${et.relayNetworkName}-node`,
      networkSecret: et.relayNetworkSecret,
      flags: {
        noTun: true,
        multiThread: true,
        enableEncryption: true,
        relayNetworkWhitelist: et.relayNetworkWhitelist,
        bindDevice: false,
        defaultProtocol: 'tcp',
        // 平台设置里的限速是「kbps」，EasyTier 的 foreign_relay_bps_limit 是「字节/秒」
        ...(s.relayBandwidthKbps > 0 ? { foreignRelayBpsLimit: kbpsToBytesPerSecond(s.relayBandwidthKbps) } : {}),
      },
      acl: null,
      fileLogDir: null,
      consoleLogLevel: 'warn',
    });
  }

  /**
   * 子节点的**运行端口**：easytier-core 实际 bind 的端口。
   * 规则本体在仓储层（`nodeListenPort`），房间服务生成票据时用的是同一份逻辑。
   */
  listenPortOf(row: NodeRow): number {
    return nodeListenPort(row, this.config.easytier.relayPort);
  }

  /** 子节点的**链接端口**：主控下发给客户端连接用的端口 */
  connectPortOf(row: NodeRow): number {
    return nodeConnectPort(row, this.config.easytier.relayPort);
  }

  /** 下发给客户端的中继地址（`host:connectPort`） */
  clientEndpointOf(row: NodeRow): string {
    return nodeClientEndpoint(row, this.config.easytier.relayPort);
  }

  /**
   * 子节点启动 easytier-core 所需的命令行参数。
   * RPC portal 必须通过命令行传入（配置文件里没有这个字段），
   * 由监听端口推导，保证同机多实例不撞车。
   */
  launchArgsFor(row: NodeRow): string[] {
    const port = this.listenPortOf(row);
    return buildLaunchArgs({
      configFile: CONFIG_PLACEHOLDER,
      rpcPortal: `127.0.0.1:${rpcPortalForListenPort(port)}`,
      rpcPortalWhitelist: ['127.0.0.1/32'],
    });
  }

  /* ------------------------------------------------------------ 认证 */

  authenticate(token: string | null): NodeRow {
    if (!token) throw HttpError.unauthorized('缺少节点令牌');
    const row = this.nodes.findByTokenHash(sha256(token.trim()));
    if (!row) throw HttpError.unauthorized('节点令牌无效');
    if (row.disabled === 1) throw HttpError.forbidden('节点已被禁用');
    return row;
  }

  /* ------------------------------------------------------------ 心跳 */

  heartbeat(
    row: NodeRow,
    input: {
      peers: number;
      rooms: number;
      rxBps: number;
      txBps: number;
      version?: string | null;
      publicIp?: string | null;
    },
  ): { disabled: boolean; configToml: string | null; configRevision: number } {
    this.nodes.updateHeartbeat(row.id, {
      peers: Math.max(0, input.peers),
      rooms: Math.max(0, input.rooms),
      rxBps: Math.max(0, input.rxBps),
      txBps: Math.max(0, input.txBps),
      version: input.version ?? null,
      publicIp: input.publicIp ?? null,
    });

    // 待上线 → 在线：首次心跳即视为节点存活（没有人工审批这一步），管理员可随时禁用
    const fresh = this.nodes.findById(row.id);
    if (fresh && fresh.status === 'pending') {
      this.nodes.setStatus(row.id, 'online');
      log.info('子节点上线', { node: row.id, name: row.name });
      this.audit.write({
        actorType: 'node',
        actorId: row.id,
        actorName: row.name,
        action: 'node.online',
        targetType: 'node',
        targetId: row.id,
      });
    } else if (fresh && fresh.status === 'offline') {
      this.nodes.setStatus(row.id, 'online');
      log.info('子节点恢复在线', { node: row.id, name: row.name });
    } else if (fresh && fresh.status === 'online' && Math.max(0, input.peers) > fresh.capacity_peers * 0.9) {
      // 接近容量上限时标记为「降级」，调度器会降低其权重
      this.nodes.setStatus(row.id, 'degraded');
    } else if (fresh && fresh.status === 'degraded' && Math.max(0, input.peers) < fresh.capacity_peers * 0.8) {
      this.nodes.setStatus(row.id, 'online');
    }

    return {
      disabled: (fresh?.disabled ?? 0) === 1,
      configToml: null,
      configRevision: fresh?.config_revision ?? 0,
    };
  }

  /* ---------------------------------------------- 外来网络（子节点侧） */

  /**
   * 记下这个子节点此刻正在转发的房间网络。
   *
   * 心跳载荷里本来就有 `roomTraffic`（逐房间网络名 + 速率），以前只拿去记账，
   * 于是控制台的「外来网络」只看得到主控自己转发的那几个 —— 玩家按区域接入后
   * 这个读数长期是 0（用户实测反馈）。
   */
  noteRelayingNetworks(nodeId: string, networks: RelayedNetworkSample[]): void {
    this.#relaying.set(nodeId, { at: Date.now(), networks });
  }

  /**
   * 聚合所有「刚心跳过」的子节点正在转发的房间网络。
   *
   * 新鲜度窗口默认 90s（心跳间隔 20s，允许连漏三次），避免节点掉线后
   * 它的网络还挂在这个读数上。被管理员禁用的节点一律不计入。
   */
  relayingNetworks(now = Date.now(), freshMs = 90_000): RelayedNetworkSample[] {
    const out: RelayedNetworkSample[] = [];
    for (const [nodeId, entry] of this.#relaying) {
      if (now - entry.at > freshMs) continue;
      const node = this.nodes.findById(nodeId);
      // 节点被删掉/被禁用后要立刻退出聚合，不能靠 90s 窗口过期
      if (!node || node.disabled === 1) continue;
      out.push(...entry.networks);
    }
    return out;
  }

  /* ------------------------------------------------------------ 管理 */

  list(filter: { region?: string; status?: string; search?: string } = {}): RelayNode[] {
    return this.nodes.list(filter).map(toNode);
  }

  get(id: string): RelayNode {
    const row = this.nodes.findById(id);
    if (!row) throw HttpError.notFound('节点不存在');
    return toNode(row);
  }

  update(
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
  ): RelayNode {
    const row = this.nodes.findById(id);
    if (!row) throw HttpError.notFound('节点不存在');
    if (fields.region && !isKnownRegion(fields.region)) {
      throw HttpError.badRequest(`未知区域: ${fields.region}`);
    }
    if (fields.endpoint) {
      if (!isValidHostPort(fields.endpoint)) throw HttpError.badRequest('endpoint 格式应为 host:port');
      const other = this.nodes.findByEndpoint(fields.endpoint);
      if (other && other.id !== id) throw HttpError.conflict('该 endpoint 已被占用');
    }
    if (fields.listenPort !== undefined && normalizePort(fields.listenPort) === null) {
      throw HttpError.badRequest('运行端口必须是 1-65535', { listenPort: '端口不合法' });
    }
    if (fields.connectPort !== undefined && normalizePort(fields.connectPort) === null) {
      throw HttpError.badRequest('链接端口必须是 1-65535', { connectPort: '端口不合法' });
    }
    /*
     * 改端口要顺带做两件事：
     *   1) endpoint 里的端口必须跟着链接端口走 —— 它对外就表示 `host:connectPort`，
     *      不改的话库里会留下一个自相矛盾的地址；
     *   2) 配置版本 +1，节点下次拉配置时才知道"运行端口变了，得重启"。
     */
    const patch: typeof fields = { ...fields };
    if (fields.connectPort !== undefined) {
      const port = normalizePort(fields.connectPort)!;
      const host = (fields.endpoint ?? row.endpoint).split(':')[0] ?? '';
      patch.endpoint = `${host}:${port}`;
      this.nodes.bumpConfigRevision(id);
    }
    if (fields.listenPort !== undefined && normalizePort(fields.listenPort) !== this.listenPortOf(row)) {
      this.nodes.bumpConfigRevision(id);
    }
    this.nodes.updateMeta(id, patch);
    const fresh = this.get(id);
    this.audit.write({
      actorType: 'admin',
      action: 'node.update',
      targetType: 'node',
      targetId: id,
      detail: {
        listenPort: fresh.listenPort,
        connectPort: fresh.connectPort,
        endpoint: fresh.endpoint,
      },
    });
    return fresh;
  }

  setDisabled(id: string, disabled: boolean): RelayNode {
    const row = this.nodes.findById(id);
    if (!row) throw HttpError.notFound('节点不存在');
    this.nodes.setDisabled(id, disabled);
    this.audit.write({
      actorType: 'admin',
      action: disabled ? 'node.disable' : 'node.enable',
      targetType: 'node',
      targetId: id,
    });
    return this.get(id);
  }

  remove(id: string): void {
    const row = this.nodes.findById(id);
    if (!row) throw HttpError.notFound('节点不存在');
    this.nodes.delete(id);
    this.audit.write({ actorType: 'admin', action: 'node.delete', targetType: 'node', targetId: id });
  }

  /** 周期性健康检查：把超时未心跳的节点标记离线 */
  healthCheck(): string[] {
    const stale = this.nodes.markStaleOffline(this.config.nodeOfflineTimeoutSeconds);
    for (const id of stale) {
      log.warn('子节点心跳超时，标记为离线', { node: id });
      this.audit.write({
        actorType: 'system',
        action: 'node.offline',
        targetType: 'node',
        targetId: id,
      });
    }
    return stale;
  }

  /** 可供房间调度使用的节点概览 */
  availableByRegion(): Array<{ region: string; online: number; total: number; peers: number; capacity: number }> {
    const all = this.nodes.list();
    const map = new Map<string, { region: string; online: number; total: number; peers: number; capacity: number }>();
    for (const n of all) {
      const entry = map.get(n.region) ?? { region: n.region, online: 0, total: 0, peers: 0, capacity: 0 };
      entry.total += 1;
      if (n.status === 'online' || n.status === 'degraded') {
        entry.online += 1;
        entry.peers += n.peers;
        entry.capacity += n.capacity_peers;
      }
      map.set(n.region, entry);
    }
    return [...map.values()].sort((a, b) => a.region.localeCompare(b.region));
  }
}
