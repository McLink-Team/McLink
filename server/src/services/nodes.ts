/**
 * 子节点（agent）服务：注册、心跳、健康检查与调度数据维护。
 *
 * 子节点是一台部署在某区域的公共中继。它的角色跟主控中继完全一样
 * （单端口 + relay_network_whitelist 通配），区别只是归属与容量。
 */
import { isKnownRegion, isValidHostPort, type RelayNode } from '@mclink/shared';
import { NodeRepo, toNode, type NodeRow } from '../db/nodes.ts';
import { EnrollKeyRepo } from '../db/users.ts';
import { AuditRepo } from '../db/traffic.ts';
import { HttpError } from '../util/errors.ts';
import { logger } from '../logger.ts';
import { sha256, shortId, randomBytesBuf } from '../util/id.ts';
import { renderEasytierToml, buildLaunchArgs, rpcPortalForListenPort, CONFIG_PLACEHOLDER } from '../easytier/config.ts';
import type { ServerConfig } from '../config.ts';
import type { SettingsService } from './settings.ts';

const log = logger('nodes');

export interface NodeAuthResult {
  node: NodeRow;
}

export class NodeService {
  private readonly config: ServerConfig;
  private readonly nodes: NodeRepo;
  private readonly enrollKeys: EnrollKeyRepo;
  private readonly audit: AuditRepo;
  private readonly settings: SettingsService;

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
      detail: { region: row.region, endpoint: row.endpoint },
    });
    log.info('子节点已注册，等待管理员启用', { node: nodeId, name: row.name, region: row.region });

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
        ...(s.relayBandwidthKbps > 0 ? { foreignRelayBpsLimit: s.relayBandwidthKbps * 1000 } : {}),
      },
      acl: null,
      fileLogDir: null,
      consoleLogLevel: 'warn',
    });
  }

  /** 子节点的监听端口（从 endpoint 推导） */
  listenPortOf(row: NodeRow): number {
    const port = Number.parseInt(row.endpoint.split(':')[1] ?? '', 10);
    return Number.isFinite(port) && port > 0 ? port : this.config.easytier.relayPort;
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

    // 待审批 → 上线（首次心跳即视为节点存活，管理员可随时禁用）
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
    fields: { name?: string; region?: string; endpoint?: string; weight?: number; capacityPeers?: number; tags?: string[] },
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
    this.nodes.updateMeta(id, fields);
    return this.get(id);
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
