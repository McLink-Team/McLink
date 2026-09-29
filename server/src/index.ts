#!/usr/bin/env node
/**
 * 主控服务端入口。
 *
 * 启动顺序：装配应用 → 初始化管理员 → 启动 HTTP/WebSocket → 启动后台任务
 * （探测 easytier-cli 版本、每 6 秒按子节点聚合流量、节点健康检查、定期清理）。
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

  /* ------------------------------------------- 主控不再自带中继（已取消） */

  /**
   * 2026-09-28 起**主控不再运行自带的中继实例**：「主控中继」这个概念已经取消，
   * 所有转发都由子节点承担（单机部署就把主控本身注册成一台普通子节点，
   * 见 `deploy/register-self-node.mjs`）。
   *
   * 为什么删掉：那个实例当初的用途是"票据里那条兜底入口"的载体，而现在票据里的中继
   * **只**来自 `relay_nodes` 的调度结果；它继续启动只会留下一个一直崩的控制台面板
   * （本机节点占了 11010 时 easytier-core 直接退出码 1，面板永远显示"未运行 + 最近错误"）。
   *
   * 随之废弃的环境变量：`MCLINK_AUTOSTART_RELAY`、`MCLINK_RELAY_RPC`、
   * `MCLINK_RELAY_NO_TUN`、`MCLINK_RELAY_MULTITHREAD`（`config.ts` 仍会读，但没有任何
   * 代码路径会因为它们改变行为）。老部署里留着它们不会有副作用；
   * `MCLINK_RELAY_PORT` 仍然有用 —— 它是**子节点中继端口**的默认值。
   */
  const cli = await app.relay.ensureCli();
  if (!cli) log.warn('easytier-cli 不可用：/meta 的 easytierVersion 会显示未知');
  if (app.config.autoStartRelay) {
    log.info('主控自带中继已取消：转发全部由子节点承担（MCLINK_AUTOSTART_RELAY 不再生效）');
  }

  /* ---------------------------------------------------- 后台任务 */

  /**
   * 流量聚合 + WebSocket 推送（每 6 秒一次）。
   *
   * 以前这件事挂在"主控中继采样事件"上；主控不再自带中继后改成**按子节点聚合**：
   * 子节点心跳（`deploy/agent.mjs`）已经在上报逐房间的累计字节与速率，
   * 逐房间的入账也在 `api/agent.ts` 里做完了，这里只负责平台读数、采样表与控制台推送。
   */
  const publishTraffic = (): void => {
    /** 所有在线子节点的速率之和（离线节点表里还留着最后上报的数，不算） */
    const nodeBps = app.nodes.totalBps();
    /** 全网外来网络：只有子节点这一种来源（按网络名去重、速率相加） */
    const foreignAll = mergeRelayedNetworks([], app.nodeService.relayingNetworks()).map((fn) => ({
      ...fn,
      roomId: app.rooms.findByNetworkName(fn.networkName)?.id ?? null,
    }));
    const ts = new Date().toISOString();

    // 平台维度采样（字节账本由会计模块写，这里只管瞬时速率曲线）
    app.traffic.record({
      scope: 'platform',
      scopeId: 'all',
      rxBytes: 0,
      txBytes: 0,
      rxBps: nodeBps.rxBps,
      txBps: nodeBps.txBps,
      peers: nodeBps.peers,
    });

    /**
     * platform 话题是**匿名可读**的，因此这里只放聚合数字。
     * 逐房间名称/带宽属于房间运营信息，只发到 traffic 话题（仅管理员），
     * 否则话题鉴权就被载荷本身绕过了。
     */
    hub.publish(Topics.platform, {
      type: 'traffic.tick',
      report: {
        ts,
        totalRxBps: nodeBps.rxBps,
        totalTxBps: nodeBps.txBps,
        masterRxBps: 0,
        masterTxBps: 0,
        nodesRxBps: nodeBps.rxBps,
        nodesTxBps: nodeBps.txBps,
        onlineRelayNodes: nodeBps.nodes,
        totalRxBytes: 0,
        totalTxBytes: 0,
        relayPeers: nodeBps.peers,
        roomCount: foreignAll.length,
      },
    });
    hub.publish(Topics.traffic, {
      type: 'traffic.tick',
      report: {
        ts,
        totalRxBps: nodeBps.rxBps,
        totalTxBps: nodeBps.txBps,
        masterRxBps: 0,
        masterTxBps: 0,
        nodesRxBps: nodeBps.rxBps,
        nodesTxBps: nodeBps.txBps,
        onlineRelayNodes: nodeBps.nodes,
        totalRxBytes: 0,
        totalTxBytes: 0,
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
    log.debug('流量聚合（子节点）', {
      nodes: nodeBps.nodes,
      peers: nodeBps.peers,
      rooms: foreignAll.length,
    });
  };

  publishTraffic();
  timers.push(setInterval(publishTraffic, 6000));

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

      /**
       * 房间中继过载 → 把大带宽节点提到主中继位置。
       *
       * 数据源就是子节点心跳报上来的逐房间速率（`relayingNetworks()`），
       * 不需要主控自己转发任何流量。**只影响新票据**：后来进房/重进房的人按新顺序连，
       * 房里的人这一局不变（用户明确接受的取舍：原来的那台已经到负载边缘，
       * 让后来的人走大管子就够了）。
       */
      const promoted = app.roomService.promoteOverloadedRooms(app.nodeService.relayingNetworks());
      for (const event of promoted) {
        log.warn('房间中继过载：已把大带宽节点提为主中继（只影响之后进房的人）', {
          room: event.roomId,
          code: event.code,
          bigPipe: event.to,
          demoted: event.from,
          rxBps: Math.round(event.rxBps),
          txBps: Math.round(event.txBps),
        });
        const row = app.rooms.findById(event.roomId);
        if (row) hub.publish(Topics.rooms, { type: 'room.update', roomId: row.id, room: toRoom(row) });
      }
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
    // 节点视图：主控不参与调度，所以这类字段只是给界面一个形状完整的对象
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
