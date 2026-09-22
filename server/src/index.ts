#!/usr/bin/env node
/**
 * 主控服务端入口。
 *
 * 启动顺序：装配应用 → 初始化管理员 → 启动 HTTP/WebSocket → 拉起主控中继 → 启动后台任务。
 * 任何一步失败都会打印可操作的提示，而不是抛栈让运维猜。
 */
import { Topics, type ForeignNetworkInfo, type RelayNode } from '@mclink/shared';
import { createApp, disposeApp, ensureBootstrapAdmin, APP_VERSION, type App } from './app.ts';
import { createServer } from './server.ts';
import { logger } from './logger.ts';
import { toRoom } from './db/rooms.ts';

const log = logger('main');

async function main(): Promise<void> {
  const app = createApp();
  const timers: NodeJS.Timeout[] = [];
  let shuttingDown = false;

  log.info(`mclink 主控 v${APP_VERSION} 启动中`, {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    dataDir: app.config.dataDir,
    db: app.config.dbFile,
  });
  for (const warning of app.warnings) log.warn(warning);

  await ensureBootstrapAdmin(app);
  if (!app.users.findByUsername(app.config.bootstrapAdminUsername) && app.users.count() === 0) {
    log.error('未能创建管理员账号，请检查配置');
  }

  const { server, hub, close } = createServer(app);

  // 把 WebSocket 的在线信息回填给路由层（避免路由反向依赖 hub）
  app.runtime.onlineUserCount = () => hub.onlineUserIds().length;
  app.runtime.wsClientCount = () => hub.clientCount;

  /**
   * 把服务内部的领域事件翻译成 WebSocket 推送。
   * 注意 ACL 只发给房主本人（sendToUser），不能发给整个房间话题——
   * 那会把「踢了谁、封了哪个 IP」这类治理信息泄露给所有成员。
   */
  app.events.on('room.changed', (roomId) => {
    const row = app.rooms.findById(roomId);
    if (!row) return;
    const members = app.roomService.members(roomId);
    hub.publish(Topics.room(roomId), { type: 'room.members', roomId, members });
    hub.publish(Topics.rooms, { type: 'room.update', roomId, room: toRoom(row) });
  });

  app.events.on('room.acl', ({ roomId, revision }) => {
    const row = app.rooms.findById(roomId);
    if (!row) return;
    hub.sendToUser(row.host_user_id, {
      type: 'room.acl',
      roomId,
      aclToml: app.roomService.aclToml(roomId),
      revision,
    });
  });

  app.events.on('room.kicked', ({ roomId, userId, reason }) => {
    hub.sendToUser(userId, { type: 'room.kicked', roomId, reason });
  });

  app.events.on('room.closed', (roomId) => {
    const row = app.rooms.findById(roomId);
    if (!row) return;
    const room = toRoom(row);
    hub.publish(Topics.room(roomId), { type: 'room.update', roomId, room });
    hub.publish(Topics.rooms, { type: 'room.update', roomId, room });
  });

  /**
   * 房间聊天广播。
   * 只发给 `room:<id>` 话题的订阅者，而该话题的订阅在 authorizeTopic 里
   * 已经要求「是该房间的活跃成员」，所以闲聊不会外泄。
   */
  app.events.on('room.message', ({ roomId, message }) => {
    hub.publish(Topics.room(roomId), { type: 'room.message', roomId, message });
  });
  app.events.on('room.messageDeleted', ({ roomId, messageId }) => {
    hub.publish(Topics.room(roomId), { type: 'room.messageDeleted', roomId, messageId });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(app.config.port, app.config.host, () => resolve());
  });

  const base = app.config.publicBaseUrl || `http://${app.config.host}:${app.config.port}`;
  log.info('HTTP 服务已监听', { url: base, port: app.config.port });
  if (!app.web.available) {
    log.warn('未找到前端构建产物，将显示兜底页面。请先执行 pnpm build:web', { root: app.web.root });
  }

  /* ---------------------------------------------------- 主控中继 */

  if (app.config.autoStartRelay) {
    const coreExists = await fileExists(app.config.easytier.coreBin);
    if (!coreExists) {
      log.error(
        `未找到 easytier-core（${app.config.easytier.coreBin}）。` +
          '请运行 `pnpm fetch:easytier` 下载，或用 MCLINK_ET_CORE 指定路径。',
      );
    } else {
      log.info('正在启动主控中继', {
        port: app.config.easytier.relayPort,
        whitelist: app.config.easytier.relayNetworkWhitelist,
      });
      const runtime = await app.relay.start();
      if (runtime.running) {
        log.info('主控中继已就绪', { listen: runtime.listen, network: runtime.networkName });
      } else {
        log.error('主控中继启动失败', { error: runtime.lastError });
      }
      const cli = await app.relay.ensureCli();
      if (!cli) {
        log.warn('easytier-cli 不可用：流量统计与 ACL 下发会被跳过');
      }
    }
  } else {
    log.warn('按配置跳过了主控中继的自动启动（MCLINK_AUTOSTART_RELAY=false）');
  }

  /* ---------------------------------------------------- 后台任务 */

  // 1) 中继采样：把状态写进流量账本，并通过 WebSocket 推送
  app.relay.on('sample', (sample) => {
    const foreignWithRooms: ForeignNetworkInfo[] = sample.foreignNetworks.map((fn) => {
      const room = app.rooms.findByNetworkName(fn.networkName);
      return { ...fn, roomId: room?.id ?? null };
    });

    /**
     * 全网聚合：主控中继 + 所有在线子节点。
     *
     * 只统计主控那一台是错的 —— 玩家按区域就近接入，绝大多数流量其实走在子节点上，
     * 于是"中继收发"长期显示 0（线上实测）。平台维度的读数与曲线都该用这个聚合值。
     */
    const nodeBps = app.nodes.totalBps();

    app.traffic.record({
      scope: 'relay',
      scopeId: 'master',
      rxBytes: sample.totalRxBytes,
      txBytes: sample.totalTxBytes,
      rxBps: sample.rxBps,
      txBps: sample.txBps,
      peers: sample.peerCount,
    });

    // 平台维度单独记一条，供流量页的「平台总收发趋势」使用（含子节点）
    app.traffic.record({
      scope: 'platform',
      scopeId: 'all',
      rxBytes: sample.totalRxBytes,
      txBytes: sample.totalTxBytes,
      rxBps: sample.rxBps + nodeBps.rxBps,
      txBps: sample.txBps + nodeBps.txBps,
      peers: sample.peerCount + nodeBps.peers,
    });

    let attributed = 0;
    for (const fn of foreignWithRooms) {
      app.traffic.record({
        scope: 'room',
        scopeId: fn.roomId ?? fn.networkName,
        roomId: fn.roomId,
        rxBytes: fn.rxBytes,
        txBytes: fn.txBytes,
        rxBps: fn.rxBps,
        txBps: fn.txBps,
        peers: fn.peerCount,
      });
      if (fn.roomId) {
        app.rooms.incrementUsage(fn.roomId, fn.rxBytes, fn.txBytes, fn.peerCount);
        attributed += 1;
      }
    }

    // 每 6 秒推一次，避免高频刷新压垮浏览器
    const now = Date.now();
    if (now - lastPlatformPush > 6000) {
      lastPlatformPush = now;
      /**
       * platform 话题是**匿名可读**的，因此这里只放聚合数字。
       * 逐房间名称/带宽属于房间运营信息，只发到 traffic 话题（仅管理员），
       * 否则话题鉴权就被载荷本身绕过了。
       */
      hub.publish(Topics.platform, {
        type: 'traffic.tick',
        report: {
          ts: sample.ts,
          // 全网聚合（主控 + 在线子节点）：只报主控的话落地页那块读数会长期是 0
          totalRxBps: sample.rxBps + nodeBps.rxBps,
          totalTxBps: sample.txBps + nodeBps.txBps,
          masterRxBps: sample.rxBps,
          masterTxBps: sample.txBps,
          nodesRxBps: nodeBps.rxBps,
          nodesTxBps: nodeBps.txBps,
          onlineRelayNodes: nodeBps.nodes,
          totalRxBytes: sample.totalRxBytes,
          totalTxBytes: sample.totalTxBytes,
          relayPeers: sample.peerCount + nodeBps.peers,
          roomCount: foreignWithRooms.length,
        },
      });
      hub.publish(Topics.traffic, {
        type: 'traffic.tick',
        report: {
          ts: sample.ts,
          totalRxBps: sample.rxBps + nodeBps.rxBps,
          totalTxBps: sample.txBps + nodeBps.txBps,
          masterRxBps: sample.rxBps,
          masterTxBps: sample.txBps,
          nodesRxBps: nodeBps.rxBps,
          nodesTxBps: nodeBps.txBps,
          onlineRelayNodes: nodeBps.nodes,
          totalRxBytes: sample.totalRxBytes,
          totalTxBytes: sample.totalTxBytes,
          byRoom: foreignWithRooms.map((f) => ({
            roomId: f.roomId ?? f.networkName,
            name: f.roomId ? (app.rooms.findById(f.roomId)?.name ?? f.networkName) : f.networkName,
            rxBps: f.rxBps,
            txBps: f.txBps,
            peers: f.peerCount,
          })),
          byNode: app.nodes.list().map((n) => ({
            nodeId: n.id,
            name: n.name,
            rxBps: n.rx_bps,
            txBps: n.tx_bps,
            peers: n.peers,
          })),
        },
      });
      hub.publish(Topics.traffic, {
        type: 'relay.update',
        relay: { ...app.relay.status(), foreignNetworks: foreignWithRooms },
      });
    }
    log.debug('中继采样', { peers: sample.peerCount, rooms: foreignWithRooms.length, attributed });
  });

  let lastPlatformPush = 0;
  app.relay.startPolling(5000);

  // 2) 节点健康检查 + 状态推送
  timers.push(
    setInterval(() => {
      const wentOffline = app.nodeService.healthCheck();
      for (const nodeId of wentOffline) {
        const node = app.nodes.findById(nodeId);
        if (node) hub.publish(Topics.nodes, { type: 'node.update', node: toNodePublic(node) });
      }
      if (wentOffline.length > 0) log.info('节点健康检查完成', { offline: wentOffline.length });
    }, 15_000),
  );

  // 3) 房间过期与空房回收
  timers.push(
    setInterval(() => {
      for (const row of app.rooms.findExpired()) {
        app.rooms.close(row.id, 'expired');
        log.info('房间已过期', { room: row.id, name: row.name });
        hub.publish(Topics.rooms, { type: 'room.update', roomId: row.id, room: toRoom(row) });
      }
      for (const row of app.rooms.findIdle(app.config.roomIdleTimeoutSeconds)) {
        app.rooms.close(row.id, 'closed');
        log.info('空房已回收', { room: row.id, name: row.name });
        hub.publish(Topics.rooms, { type: 'room.update', roomId: row.id, room: toRoom(row) });
      }
      // 成员在线状态刷新
      const openRows = app.rooms.listAll({ status: 'open', limit: 200 }).rows;
      for (const row of openRows) app.rooms.recalcCounts(row.id);
    }, 30_000),
  );

  // 4) 会话清理与流量/聊天数据保留
  /**
   * 分批清理，每批之间让出事件循环。
   *
   * 原来是一条同步 `delete ... where ts < ?` 删完所有过期采样：库里几十万行时
   * 这条语句会把事件循环按住几秒到几十秒，期间主控连 TCP 都不应答 ——
   * nginx 报 `upstream timed out (110) while connecting to upstream`，
   * 心跳和静态资源一起挂（线上就是这么表现的）。现在每批 5000 行、批间 setImmediate，
   * 单次阻塞降到毫秒级，清理进度也不会因为一次跑不完而丢掉（下一小时继续）。
   */
  const purgeOldData = async (): Promise<void> => {
    const sessions = app.users.purgeExpiredSessions();
    let samples = 0;
    // 上限 400 批（200 万行）纯粹是防御：正常每小时只会有几千行过期
    for (let i = 0; i < 400; i += 1) {
      const removed = app.traffic.pruneBatch(72, 5000);
      samples += removed;
      if (removed < 5000) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    // 聊天记录只保留 7 天：房间早就关了的话，留着也没有意义（同样分批）
    let chat = 0;
    for (let i = 0; i < 100; i += 1) {
      const removed = app.messages.pruneOlderThan(24 * 7, 2000);
      chat += removed;
      if (removed < 2000) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (sessions > 0 || samples > 0 || chat > 0) {
      log.debug('定期清理完成', { sessions, samples, chat });
    }
  };
  timers.push(
    setInterval(() => {
      void purgeOldData().catch((err: unknown) => {
        log.warn('定期清理失败', { error: err instanceof Error ? err.message : String(err) });
      });
    }, 3600_000),
  );

  // 5) 平台概览推送（给管理台与落地页的在线人数）
  timers.push(
    setInterval(async () => {
      const nodeCounts = app.nodes.countByStatus();
      hub.publish(Topics.platform, {
        type: 'notice',
        level: 'info',
        message: JSON.stringify({
          onlineNodes: (nodeCounts.online ?? 0) + (nodeCounts.degraded ?? 0),
          openRooms: app.rooms.countOpen(),
          onlinePlayers: app.rooms.onlinePlayers(),
          wsClients: hub.clientCount,
        }),
      });
    }, 20_000),
  );

  for (const timer of timers) timer.unref?.();

  log.info('mclink 主控已就绪', { url: base, version: APP_VERSION });

  /* ---------------------------------------------------- 优雅退出 */

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${signal}，正在关闭…`);
    for (const timer of timers) clearInterval(timer);
    await app.relay.stop();
    await close();
    disposeApp(app);
    log.info('已安全退出');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 拒绝', { error: reason instanceof Error ? reason.message : String(reason) });
  });
  process.on('uncaughtException', (err) => {
    log.error('未捕获异常', { error: err.message, stack: err.stack });
  });
}

function toNodePublic(row: {
  id: string;
  name: string;
  region: string;
  endpoint: string;
  status: string;
  peers: number;
  rooms: number;
  rx_bps: number;
  tx_bps: number;
}): RelayNode {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    endpoint: row.endpoint,
    // 这里描述的是主控自己的中继：没有 NAT 映射，两个端口就是同一个
    listenPort: null,
    connectPort: null,
    publicIp: null,
    status: row.status as RelayNode['status'],
    version: null,
    capacityPeers: 0,
    peers: row.peers,
    rooms: row.rooms,
    rxBps: row.rx_bps,
    txBps: row.tx_bps,
    weight: 0,
    tags: [],
    lastSeenAt: null,
    createdAt: new Date().toISOString(),
  };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const fs = await import('node:fs/promises');
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  log.error('启动失败', { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exit(1);
});
