/**
 * 子节点 agent 接口。
 *
 * 部署在各地的中继节点上运行一个小 agent（参见 deploy/agent.mjs），
 * 它用注册密钥换取长期令牌，然后定期心跳上报负载与逐房间流量。
 */
import { Routes } from '@mclink/shared';
import type { App } from '../app.ts';
import type { RelayedNetworkSample } from '../services/nodes.ts';
import type { Router, Ctx } from '../http/kit.ts';
import { bearerToken, optInt, optStr } from './helpers.ts';
import { HttpError } from '../util/errors.ts';
import { logger } from '../logger.ts';

const log = logger('api:agent');

function requireNode(app: App, ctx: Ctx) {
  return app.nodeService.authenticate(bearerToken(ctx));
}

export function registerAgentRoutes(router: Router, app: App): void {
  /** 用注册密钥换取节点令牌 */
  router.post(Routes.agentRegister, async (ctx) => {
    const body = await ctx.body();
    const enrollKey = optStr(body, 'enrollKey', 64);
    if (!enrollKey) throw HttpError.badRequest('缺少 enrollKey');
    const result = app.nodeService.enroll({
      enrollKey,
      name: optStr(body, 'name', 40) ?? 'relay-node',
      region: optStr(body, 'region', 24) ?? 'cn-east',
      endpoint: optStr(body, 'endpoint', 120) ?? '',
      // 运行端口与链接端口分开传：NAT 后面本机绑一个、对外开另一个
      listenPort: optInt(body, 'listenPort', 1, 65535),
      connectPort: optInt(body, 'connectPort', 1, 65535),
      capacityPeers: optInt(body, 'capacityPeers', 10, 100_000),
      version: optStr(body, 'version', 60) ?? null,
      tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t).slice(0, 24)).slice(0, 8) : [],
      publicIp: ctx.ip,
    });
    log.info('子节点注册完成', {
      node: result.node.id,
      region: result.node.region,
      listenPort: result.node.listenPort,
      connectPort: result.node.connectPort,
    });
    return result;
  });

  /** 心跳 */
  router.post(Routes.agentHeartbeat, async (ctx) => {
    const row = requireNode(app, ctx);
    const body = await ctx.body();
    const result = app.nodeService.heartbeat(row, {
      peers: optInt(body, 'peers', 0, 1_000_000) ?? 0,
      rooms: optInt(body, 'rooms', 0, 100_000) ?? 0,
      rxBps: optInt(body, 'rxBps', 0, 1e12) ?? 0,
      txBps: optInt(body, 'txBps', 0, 1e12) ?? 0,
      version: optStr(body, 'version', 60) ?? null,
      publicIp: optStr(body, 'publicIp', 64) ?? ctx.ip,
    });

    // 逐房间流量落库，用于平台级流量账本
    if (Array.isArray(body.roomTraffic)) {
      const items: Array<Parameters<App['traffic']['record']>[0]> = [];
      /** 这个节点此刻在转发的房间网络 —— 给控制台的「外来网络」做全网聚合 */
      const relayed: RelayedNetworkSample[] = [];
      for (const raw of body.roomTraffic.slice(0, 512)) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as Record<string, unknown>;
        const networkName = typeof entry.networkName === 'string' ? entry.networkName : '';
        if (!networkName) continue;
        const roomRow = app.rooms.findByNetworkName(networkName);
        const rxBytes = typeof entry.rxBytes === 'number' ? entry.rxBytes : 0;
        const txBytes = typeof entry.txBytes === 'number' ? entry.txBytes : 0;
        const peerCount = typeof entry.peerCount === 'number' ? entry.peerCount : 0;
        relayed.push({
          networkName,
          peers: peerCount,
          rxBps: typeof entry.rxBps === 'number' ? entry.rxBps : 0,
          txBps: typeof entry.txBps === 'number' ? entry.txBps : 0,
          rxBytes,
          txBytes,
        });
        items.push({
          scope: 'room',
          scopeId: roomRow?.id ?? networkName,
          roomId: roomRow?.id ?? null,
          rxBytes,
          txBytes,
          rxBps: typeof entry.rxBps === 'number' ? entry.rxBps : 0,
          txBps: typeof entry.txBps === 'number' ? entry.txBps : 0,
          peers: peerCount,
        });
        if (roomRow) {
          app.rooms.incrementUsage(roomRow.id, rxBytes, txBytes, peerCount);
        }
      }
      app.traffic.recordMany(items);
      /**
       * 空数组也要记：节点停止转发后，必须把它从「外来网络」聚合里清掉，
       * 否则控制台会一直挂着一个已经不存在的网络（直到新鲜度窗口过期）。
       */
      app.nodeService.noteRelayingNetworks(row.id, relayed);
    }

    // 节点级样本
    app.traffic.record({
      scope: 'node',
      scopeId: row.id,
      rxBytes: 0,
      txBytes: 0,
      rxBps: optInt(body, 'rxBps', 0, 1e12) ?? 0,
      txBps: optInt(body, 'txBps', 0, 1e12) ?? 0,
      peers: optInt(body, 'peers', 0, 1_000_000) ?? 0,
    });

    return {
      ok: true as const,
      configToml: result.configToml,
      configRevision: result.configRevision,
      disabled: result.disabled,
    };
  });

  /** 拉取当前应使用的配置 */
  router.get(Routes.agentConfig, (ctx) => {
    const row = requireNode(app, ctx);
    return {
      configToml: app.nodeService.renderNodeConfig(row),
      launchArgs: app.nodeService.launchArgsFor(row),
      listenPort: app.nodeService.listenPortOf(row),
      connectPort: app.nodeService.connectPortOf(row),
      configRevision: row.config_revision,
      heartbeatIntervalSeconds: app.config.nodeHeartbeatIntervalSeconds,
    };
  });

  /* ---------------------------------------------------------- 一键安装 */

  /*
   * 注意：安装脚本与 agent.mjs 的托管**不在这里**。
   * 它们放在根路径 `/agent/install.sh`、`/agent/agent.mjs`（见 server.ts），
   * 这样运维拿到的是 `curl -fsSL <主控>/agent/install.sh | sudo bash -s -- …`
   * 这种一眼就懂的一行命令，而不是带 /api/v1 前缀的接口地址。
   */
}
