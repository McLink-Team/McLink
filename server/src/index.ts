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
import { mergeRelayedNetworks } from './services/nodes.ts';
import { logger } from './logger.ts';
import { describeTrustedProxies } from './util/net.ts';
import type { ServerConfig } from './config.ts';
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
    /**
     * backlog 显式调大（Node 默认 511）。
     *
     * 主控是单线程的：事件循环一旦被占住，内核只能靠 accept 队列顶住新连接；
     * 队列满就直接丢 SYN，客户端重试到 proxy_connect_timeout 就是
     * `upstream timed out (110) while connecting to upstream`。
     * 调大队列能多扛一次"断线重连风暴"，但真正要配的是客户端的重连抖动
     * （packages/shared/src/backoff.ts）—— 让这一波不要挤在同一毫秒回来。
     */
    server.listen({ port: app.config.port, host: app.config.host, backlog: 2048 }, () => resolve());
  });

  const base = app.config.publicBaseUrl || `http://${app.config.host}:${app.config.port}`;
  log.info('HTTP 服务已监听', { url: base, port: app.config.port });
  logRealIpMode(app.config);
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
    /**
     * 主控自己转发的外来网络。
     * `relay.update` 是「主控中继面板」的数据源，口径**保持只看主控** ——
     * 把子节点带的网络混进去，那一页的读数就变成两码事了。
     */
    const masterForeign: ForeignNetworkInfo[] = sample.foreignNetworks.map((fn) => {
      const room = app.rooms.findByNetworkName(fn.networkName);
      return { ...fn, roomId: room?.id ?? null };
    });

    /**
     * 全网外来网络：主控 + 所有在线子节点，按网络名去重、速率相加。
     *
     * 玩家是按区域就近接入的，房间流量大多走在子节点上；只看主控的话，
     * 控制台的「外来网络」和流量页的按房间视图会长期是 0 或残缺（用户实测反馈）。
     */
    const foreignAll = mergeRelayedNetworks(
      sample.foreignNetworks.map((fn) => ({
        networkName: fn.networkName,
        peers: fn.peerCount,
        rxBps: fn.rxBps,
        txBps: fn.txBps,
        rxBytes: fn.rxBytes,
        txBytes: fn.txBytes,
      })),
      app.nodeService.relayingNetworks(),
    ).map((fn) => ({ ...fn, roomId: app.rooms.findByNetworkName(fn.networkName)?.id ?? null }));

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

    /**
     * 真实账本入账：把"从实例启动算起的累计值"变成增量，写进 room_usage / users.used_bytes /
     * traffic_ledger（见 services/traffic-ledger.ts）。以前这里直接把累计值覆盖写进
     * room_usage，于是中继一重启房间累计就归零 —— 控制台的「累计流量」因此长期不可信。
     *
     * 主控中继换了实例（重启）时先丢基线：新实例的计数器从 0 开始，
     * 保留旧基线会让回退判定把"新实例的累计"当成增量重复入账。
     */
    const relayStartedAt = app.relay.status().startedAt;
    if (relayStartedAt !== lastRelayStartedAt) {
      lastRelayStartedAt = relayStartedAt;
      app.accountant.forgetSource('master');
    }
    const accounted = app.accountant.account(
      'master',
      sample.foreignNetworks.map((fn) => ({
        networkName: fn.networkName,
        rxBytes: fn.rxBytes,
        txBytes: fn.txBytes,
        peerCount: fn.peerCount,
      })),
    );

    /**
     * 房间维度的**瞬时速率**曲线仍写 traffic_samples（流量页的近一小时曲线用它）；
     * 字节账本在 accountant 里写（两者分工见 db/traffic.ts 的注释）。
     */
    for (const fn of masterForeign) {
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
    }
    const attributed = accounted.rooms;

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
          roomCount: foreignAll.length,
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
          // 按房间归因也用全网口径：子节点带的房间同样要出现在这里
          byRoom: foreignAll.map((f) => ({
            roomId: f.roomId ?? f.networkName,
            name: f.roomId ? (app.rooms.findById(f.roomId)?.name ?? f.networkName) : f.networkName,
            rxBps: f.rxBps,
            txBps: f.txBps,
            peers: f.peers,
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
        // 只看主控：这一帧是给「主控中继面板」用的
        relay: { ...app.relay.status(), foreignNetworks: masterForeign },
      });
    }
    log.debug('中继采样', {
      peers: sample.peerCount,
      rooms: foreignAll.length,
      attributed,
      rxDelta: accounted.rxBytes,
      txDelta: accounted.txBytes,
      userBytes: accounted.userBytes,
    });
  });

  let lastPlatformPush = 0;
  /** 主控中继实例的启动时间：换了实例就要丢掉账本基线（见上面的 forgetSource） */
  let lastRelayStartedAt: string | null = null;
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
    /**
     * 会话也一样分批。
     *
     * 批大小按"单批最坏阻塞时长"定：实测（1 万到 100 万行）无界 DELETE 最坏
     * 385ms～4.3 秒，2000/批最坏 113～745ms，500/批约 30～190ms。
     * 主控是单线程的，单批越短，被顶住的事件循环越短 —— 批数多一点无所谓，
     * 反正批间 setImmediate 会让出循环。
     */
    let sessions = 0;
    for (let i = 0; i < 400; i += 1) {
      const removed = app.users.pruneExpiredSessions(500);
      sessions += removed;
      if (removed < 500) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    /**
     * 采样表分批删除。批大小同样是按"单批最坏阻塞"定的：实测 100 万行库上
     * 5000/批最坏 483ms，500 万行库上 5000/批最坏 1,129ms；改成 1000/批
     * 大约降到 100～230ms。（无界 DELETE 在 500 万行时要 96 秒，等于主控
     * 整整一分半完全不应答，任何代理都会先超时。）
     */
    let samples = 0;
    for (let i = 0; i < 2000; i += 1) {
      const removed = app.traffic.pruneBatch(72, 1000);
      samples += removed;
      if (removed < 1000) break;
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
    /**
     * 流量账本保留 400 天：采样表（72 小时）管曲线，账本管"这个月用了多少"。
     * 同样分批 —— 一年下来按分钟桶 × 维度也就百万级行，一批 2000 行足够。
     */
    let ledger = 0;
    for (let i = 0; i < 2000; i += 1) {
      const removed = app.ledger.pruneBatch(400, 2000);
      ledger += removed;
      if (removed < 2000) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (sessions > 0 || samples > 0 || chat > 0 || ledger > 0) {
      log.debug('定期清理完成', { sessions, samples, chat, ledger });
    }
    /**
     * 维护窗口里做一次显式 checkpoint：把 WAL 累积的页写回主库并截断文件。
     *
     * 特意放在这里而不是让 SQLite 在某个请求里自动做 —— 自动 checkpoint 会同步落在
     * 触发它的那次写入上，那一次卡顿正好会打在正在处理的请求上（见 db/index.ts 的
     * wal_autocheckpoint 说明）。这里的耗时也记下来，便于观察它是否开始变慢。
     */
    const ckpt = app.db.checkpoint('TRUNCATE');
    if (ckpt.ms >= 200) log.warn('WAL checkpoint 偏慢', ckpt);
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
    // 主控中继不参与"按带宽调度"（它永远是兜底，没法被排除掉），所以不带带宽上限
    capacityBps: 0,
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

/**
 * 把"真实 IP 是怎么算出来的"写进启动日志。
 *
 * 为什么值得专门记一行：反代后面"所有人都是 127.0.0.1"或"限流把整站算成一个人"
 * 这类问题，只有能看到判定依据（信任谁、从哪个头取）时才查得动；
 * 配置写错也要在这里报出来，而不是安静地按兼容模式跑。
 */
function logRealIpMode(config: ServerConfig): void {
  if (!config.trustProxy) {
    log.info('真实 IP：不信任反向代理头（MCLINK_TRUST_PROXY=false），一律使用直连对端地址');
  } else if (config.trustedProxies.length > 0) {
    log.info('真实 IP：信任反向代理头，取转发链里最右侧的非可信跳', {
      trusted: describeTrustedProxies(config.trustedProxies),
    });
  } else {
    log.warn(
      '真实 IP：兼容模式 —— 信任回环与私网来源的转发头。若反代与主控不同机（容器/网关），' +
        '或需要挡住"内网客户端伪造 X-Forwarded-For"，请显式设置 MCLINK_TRUSTED_PROXIES' +
        '（同机 nginx 写 127.0.0.1/8,::1/128）',
    );
  }
  if (config.trustedProxiesInvalid.length > 0) {
    log.warn('MCLINK_TRUSTED_PROXIES 里有无法解析的项，已忽略', {
      invalid: config.trustedProxiesInvalid.join(', '),
    });
  }
}

main().catch((err) => {
  log.error('启动失败', { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exit(1);
});
