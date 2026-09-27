/** 管理员接口：仪表盘、节点管理、房间管理、用户管理、流量、审计、平台设置 */
import { Routes, DEFAULT_GITHUB_PROXY, emailProblem, parseUsernameList, regionLabel, type BroadcastAudience, type PlatformSettings, type SmtpEncryption } from '@mclink/shared';
import type { App } from '../app.ts';
import type { Router } from '../http/kit.ts';
import { optBool, optInt, optStr, paging, req, requireAdmin } from './helpers.ts';
import { HttpError } from '../util/errors.ts';
import { logger } from '../logger.ts';
import { endpointHost, toNode } from '../db/nodes.ts';
import { toRoom } from '../db/rooms.ts';
import { enrollKey as makeEnrollKey } from '../util/id.ts';
import { buildOverview } from './public.ts';
import { DEFAULT_SETTINGS, toPublicSettings } from '../services/settings.ts';
import { SCHEMA_VERSION } from '../db/schema.ts';
import { mergeRelayedNetworks } from '../services/nodes.ts';
import { localBucket, localDay } from '../db/traffic.ts';

const log = logger('api:admin');

/**
 * 解析群发的收件人筛选（GET 走 query、POST 走 body，所以这里收的是裸值）。
 *
 * 越界的值一律**夹到合法区间**而不是报错：管理员在界面上点来点去，
 * 因为一个数字越界就发不出去，比"按最接近的合法值处理"体验差得多。
 */
function audienceFrom(
  rolesRaw: string | undefined,
  daysRaw: string | number | undefined,
  namesRaw: string | undefined,
): BroadcastAudience {
  const roles = rolesRaw === 'admin' || rolesRaw === 'user' ? rolesRaw : 'all';
  const days = daysRaw === undefined || daysRaw === '' ? Number.NaN : Number(daysRaw);
  const activeWithinDays = !Number.isFinite(days) || days <= 0 ? null : Math.min(Math.trunc(days), 3650);
  return { roles, activeWithinDays, usernames: parseUsernameList(namesRaw ?? '') };
}

/**
 * 读取一个"允许为空"的字符串字段。
 * 与 `optStr` 的区别：空字符串会被保留（用于清空 SMTP 主机、发件人这类可选项），
 * 未出现该字段时才返回 undefined。
 */
function stringField(body: Record<string, unknown>, key: string, max: number): string | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** 审计日志里不留明文密码 */
function redactPatch(patch: Partial<PlatformSettings>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...patch };
  if ('smtpPassword' in out) out.smtpPassword = out.smtpPassword === null ? null : '<已隐藏>';
  return out;
}

/**
 * 账本用的分钟桶：`minutes` 分钟前的那个桶（本地时间，与 `traffic_ledger.bucket` 同口径）
 */
function bucketSince(minutes: number): string {
  return localBucket(new Date(Date.now() - Math.max(1, minutes) * 60_000));
}

export function registerAdminRoutes(router: Router, app: App): void {
  /* ---------------------------------------------------------- 仪表盘 */

  router.get(Routes.adminOverview, (ctx) => {
    requireAdmin(ctx);
    const overview = buildOverview(app);
    const recentAudit = app.audit.recent(15);
    const nodes = app.nodeService.list();
    const rooms = app.rooms.listAll({ status: 'open', limit: 20 }).rows.map(toRoom);

    return {
      ...overview,
      users: { ...overview.users, online: app.runtime.onlineUserCount?.() ?? 0 },
      system: {
        nodeVersion: process.version,
        platform: `${process.platform}/${process.arch}`,
        schemaVersion: SCHEMA_VERSION,
        dbFile: app.db.file,
        pid: process.pid,
        memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      },
      /** 最近节点/房间，用于仪表盘的「前 N」表格；计数在 overview.nodes / overview.rooms 里 */
      recentNodes: nodes.slice(0, 12),
      recentRooms: rooms.slice(0, 12),
      recentAudit,
      warnings: app.warnings,
    };
  }, { auth: true, admin: true });

  /* ---------------------------------------------------------- 节点 */

  router.get(Routes.adminNodes, (ctx) => {
    requireAdmin(ctx);
    return app.nodeService.list({
      region: ctx.query.get('region') ?? undefined,
      status: ctx.query.get('status') ?? undefined,
      search: ctx.query.get('search') ?? undefined,
    });
  }, { auth: true, admin: true });

  router.get('/admin/nodes/regions', (ctx) => {
    requireAdmin(ctx);
    return app.nodeService.availableByRegion();
  }, { auth: true, admin: true });

  router.post(Routes.adminNodeEnrollKey, async (ctx) => {
    const auth = requireAdmin(ctx);
    const body = await ctx.body();
    const key = makeEnrollKey();
    const row = app.enrollKeys.create(key, optStr(body, 'note', 80) ?? null, auth.userId);
    app.audit.write({
      actorType: 'admin',
      actorId: auth.userId,
      actorName: auth.username,
      action: 'node.enroll_key',
      targetType: 'enroll_key',
      targetId: key,
      ip: ctx.ip,
    });
    log.info('已签发节点注册密钥', { by: auth.username });
    // 签发时就把部署参数一并收下：控制台填好"要装在哪、跑哪个端口"，直接拿到可粘贴的命令
    const options = {
      region: optStr(body, 'region', 24),
      name: optStr(body, 'name', 40),
      host: optStr(body, 'host', 120),
      listenPort: optInt(body, 'listenPort', 1, 65535),
      connectPort: optInt(body, 'connectPort', 1, 65535),
      domestic: optBool(body, 'domestic') === true,
      githubProxy: optStr(body, 'githubProxy', 200),
    };
    return {
      enrollKey: key,
      note: row.note,
      createdAt: row.created_at,
      /** 节点侧一键安装命令：整条命令复制到 Debian 上执行即可 */
      command: buildAgentCommand(app, key, options),
      params: {
        region: options.region ?? 'cn-east',
        name: options.name ?? 'relay-sh',
        host: options.host ?? null,
        listenPort: options.listenPort ?? app.config.easytier.relayPort,
        connectPort: options.connectPort ?? options.listenPort ?? app.config.easytier.relayPort,
        domestic: options.domestic,
        githubProxy: options.domestic ? normalizeGithubProxy(options.githubProxy) : null,
      },
    };
  }, { auth: true, admin: true });

  router.get('/admin/nodes/enroll-keys', (ctx) => {
    requireAdmin(ctx);
    return app.enrollKeys.list(100).map((k) => ({
      key: k.key,
      note: k.note,
      createdAt: k.created_at,
      usedAt: k.used_at,
      usedBy: k.used_by,
      revoked: k.revoked === 1,
    }));
  }, { auth: true, admin: true });

  /**
   * 给**已有节点**重新生成「安装指令」。
   *
   * 为什么要重新签密钥：注册密钥是一次性的，节点表里存的是哈希，原文拿不回来。
   * 参数默认取这个节点现有记录（区域/名字/端口/主机名），换机器或换端口时可以用 body 覆盖。
   *
   * 一个容易误解的点（界面上也要写清楚）：**同一台机器重装不会换身份** ——
   * install-node.sh 不删 /etc/mclink/node-token.json，agent 会继续用原来的节点 ID，
   * 这把新密钥会保持未使用。只有换机器安装才会真的用掉它。
   */
  router.post('/admin/nodes/:id/reinstall-command', async (ctx) => {
    const auth = requireAdmin(ctx);
    const body = await ctx.body();
    const node = app.nodeService.get(ctx.params.id ?? '');
    const key = makeEnrollKey();
    app.enrollKeys.create(key, `重装节点 ${node.name}`, auth.userId);
    const command = buildAgentCommand(app, key, {
      region: node.region,
      name: node.name,
      // 节点表里的 endpoint 是 host:port；这里只要 host，端口用节点自己的链接端口
      host: optStr(body, 'host', 120) ?? endpointHost(node.endpoint),
      listenPort: node.listenPort ?? undefined,
      connectPort: node.connectPort ?? undefined,
      domestic: optBool(body, 'domestic') === true,
      githubProxy: optStr(body, 'githubProxy', 200),
    });
    app.audit.write({
      actorType: 'admin',
      actorId: auth.userId,
      actorName: auth.username,
      action: 'node.reinstall_command',
      targetType: 'node',
      targetId: node.id,
      detail: { enrollKey: key },
      ip: ctx.ip,
    });
    return { enrollKey: key, command };
  }, { auth: true, admin: true });

  /**
   * 「更新指令」：不换令牌，只把节点上的 agent / 二进制 / systemd 单元刷到最新并重启。
   *
   * 配置本身不需要这条命令 —— agent 每次心跳都会应用主控下发的 configToml
   * （有变化才写盘并重启核心）。这条命令解决的是另一半：脚本与单元也会随版本更新。
   */
  router.get('/admin/nodes/:id/update-command', (ctx) => {
    requireAdmin(ctx);
    app.nodeService.get(ctx.params.id ?? '');
    return { command: buildAgentUpdateCommand(app) };
  }, { auth: true, admin: true });

  router.patch('/admin/nodes/:id', async (ctx) => {
    const auth = requireAdmin(ctx);
    const body = await ctx.body();
    const node = app.nodeService.update(ctx.params.id ?? '', {
      name: optStr(body, 'name', 40),
      region: optStr(body, 'region', 24),
      endpoint: optStr(body, 'endpoint', 120),
      // 两个端口都可以单独改：节点换机房/改端口映射时不用重新注册
      listenPort: optInt(body, 'listenPort', 1, 65535),
      connectPort: optInt(body, 'connectPort', 1, 65535),
      weight: optInt(body, 'weight', 0, 100000),
      capacityPeers: optInt(body, 'capacityPeers', 10, 100_000),
      // 带宽上限（bit/s）：0 = 不限。调度会按 3 分钟 EWMA 利用率算余量
      capacityBps: optInt(body, 'capacityBps', 0, 1e12),
      tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t).slice(0, 24)).slice(0, 8) : undefined,
    });
    app.audit.write({
      actorType: 'admin',
      actorId: auth.userId,
      actorName: auth.username,
      action: 'node.update',
      targetType: 'node',
      targetId: node.id,
      detail: body,
      ip: ctx.ip,
    });
    return node;
  }, { auth: true, admin: true });

  router.post('/admin/nodes/:id/disable', async (ctx) => {
    const auth = requireAdmin(ctx);
    const body = await ctx.body();
    const node = app.nodeService.setDisabled(ctx.params.id ?? '', body.disabled !== false);
    app.audit.write({
      actorType: 'admin',
      actorId: auth.userId,
      actorName: auth.username,
      action: node.status === 'disabled' ? 'node.disable' : 'node.enable',
      targetType: 'node',
      targetId: node.id,
      ip: ctx.ip,
    });
    return node;
  }, { auth: true, admin: true });

  router.delete('/admin/nodes/:id', (ctx) => {
    const auth = requireAdmin(ctx);
    app.nodeService.remove(ctx.params.id ?? '');
    app.audit.write({
      actorType: 'admin',
      actorId: auth.userId,
      actorName: auth.username,
      action: 'node.delete',
      targetType: 'node',
      targetId: ctx.params.id ?? '',
      ip: ctx.ip,
    });
    return { ok: true };
  }, { auth: true, admin: true });

  /* ---------------------------------------------------------- 房间 */

  router.get(Routes.adminRooms, (ctx) => {
    requireAdmin(ctx);
    const { limit, offset } = paging(ctx);
    const result = app.rooms.listAll({
      status: ctx.query.get('status') ?? undefined,
      search: ctx.query.get('search') ?? undefined,
      limit,
      offset,
    });
    return {
      rooms: result.rows.map((row) => ({
        ...toRoom(row),
        usage: app.rooms.usage(row.id) ?? { rxBytes: 0, txBytes: 0, peers: 0 },
      })),
      total: result.total,
    };
  }, { auth: true, admin: true });

  router.get('/admin/rooms/:id', (ctx) => {
    requireAdmin(ctx);
    const roomId = ctx.params.id ?? '';
    const row = app.roomService.getRow(roomId);
    return {
      room: toRoom(row),
      members: app.roomService.members(roomId),
      networkSecret: row.network_secret,
      usage: app.rooms.usage(roomId) ?? { rxBytes: 0, txBytes: 0, peers: 0 },
      accessLog: app.rooms.recentAccess(roomId, 50),
      aclToml: app.roomService.aclToml(roomId),
    };
  }, { auth: true, admin: true });

  router.delete('/admin/rooms/:id', (ctx) => {
    const auth = requireAdmin(ctx);
    const roomId = ctx.params.id ?? '';
    const row = app.roomService.getRow(roomId);
    app.rooms.close(roomId, 'closed');
    app.audit.write({
      actorType: 'admin',
      actorId: auth.userId,
      actorName: auth.username,
      action: 'room.force_close',
      targetType: 'room',
      targetId: roomId,
      detail: { name: row.name, code: row.code },
      ip: ctx.ip,
    });
    log.warn('管理员强制关闭房间', { room: roomId, by: auth.username });
    return { ok: true };
  }, { auth: true, admin: true });

  /* ---------------------------------------------------------- 用户 */

  router.get(Routes.adminUsers, (ctx) => {
    requireAdmin(ctx);
    const { limit, offset } = paging(ctx);
    const result = app.users.list({ search: ctx.query.get('search') ?? undefined, limit, offset });
    return {
      users: result.rows.map((row) => ({
        ...app.users.toSelf(row),
        hostedRooms: app.rooms.countActiveByHost(row.id),
      })),
      total: result.total,
    };
  }, { auth: true, admin: true });

  router.patch('/admin/users/:id', async (ctx) => {
    const auth = requireAdmin(ctx);
    const userId = ctx.params.id ?? '';
    const body = await ctx.body();
    const target = app.users.findById(userId);
    if (!target) throw HttpError.notFound('用户不存在');

    if (typeof body.banned === 'boolean') {
      if (userId === auth.userId) throw HttpError.badRequest('不能封禁自己');
      app.users.setBanned(userId, body.banned);
      if (body.banned) app.users.deleteSessionsForUser(userId);
    }
    if (typeof body.role === 'string' && ['admin', 'user'].includes(body.role)) {
      if (userId === auth.userId && body.role !== 'admin') {
        throw HttpError.badRequest('不能撤销自己的管理员权限');
      }
      app.users.setRole(userId, body.role as 'admin' | 'user');
    }
    if ('quotaBytes' in body || 'maxRooms' in body) {
      const quota = body.quotaBytes === null ? null : optInt(body, 'quotaBytes', 0, Number.MAX_SAFE_INTEGER) ?? null;
      const maxRooms = body.maxRooms === null ? null : optInt(body, 'maxRooms', 0, 999) ?? null;
      app.users.setQuota(
        userId,
        quota === undefined ? target.quota_bytes : quota,
        maxRooms === undefined ? target.max_rooms : maxRooms,
      );
    }
    if (body.resetUsage === true) app.users.resetUsage(userId);

    app.audit.write({
      actorType: 'admin',
      actorId: auth.userId,
      actorName: auth.username,
      action: 'user.update',
      targetType: 'user',
      targetId: userId,
      detail: body,
      ip: ctx.ip,
    });
    return app.users.toSelf(app.users.findById(userId)!);
  }, { auth: true, admin: true });

  /* ---------------------------------------------------------- 流量 */

  router.get(Routes.adminTraffic, (ctx) => {
    requireAdmin(ctx);
    const minutes = Number.parseInt(ctx.query.get('minutes') ?? '60', 10);
    const since = new Date(Date.now() - Math.min(Math.max(minutes, 5), 60 * 24 * 7) * 60_000).toISOString();
    const scope = ctx.query.get('scope') ?? 'platform';
    const scopeId = ctx.query.get('scopeId') ?? '';

    const platformPoints = app.traffic.platformSeries(since, 480);
    /** 全网口径：所有在线子节点的速率之和（离线节点表里还留着最后上报的数，不算） */
    const nodeBps = app.nodes.totalBps();

    /**
     * 字节账本（`traffic_ledger`）：今日/本月/累计、逐房间与逐用户的"用了多少流量"都读它。
     * 它记的是**增量累加**，所以中继重启、多台节点同时转发都不会让数字失真
     * （原因见 db/schema.ts 的 V22 迁移注释与 services/traffic-ledger.ts）。
     */
    const today = localDay();
    const monthStart = localDay(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    /** 各维度"今日"的明细，查一次复用（按 scope_id 索引） */
    const ledgerOf = (scope: 'room' | 'node' | 'user'): Map<string, { rxBytes: number; txBytes: number }> =>
      new Map(
        app.ledger.byScope({ scope, sinceDay: today, limit: 1000 }).map((row) => [
          row.scopeId,
          { rxBytes: row.rxBytes, txBytes: row.txBytes },
        ]),
      );
    const todayBytes = app.ledger.sum({ scope: 'platform', scopeId: 'all', sinceDay: today });

    const rooms = scope === 'room' && scopeId
      ? [{ id: scopeId, label: scopeId, points: app.traffic.series('room', scopeId, since, 480) }]
      : app
          .rooms
          .listAll({ status: 'open', limit: 20 })
          .rows.map((row) => {
            const usage = app.rooms.usage(row.id);
            return {
              id: row.id,
              label: `${row.name} (${row.code})`,
              points: app.traffic.series('room', row.id, since, 120),
              /** 累计流量（账本累加，重启不归零、两台节点同时转发也会相加） */
              rxBytes: usage?.rxBytes ?? 0,
              txBytes: usage?.txBytes ?? 0,
              peers: usage?.peers ?? 0,
              today: ledgerOf('room').get(row.id) ?? { rxBytes: 0, txBytes: 0 },
            };
          });

    const nodes = app.nodeService.list().map((n) => ({
      id: n.id,
      label: `${n.name} (${regionLabel(n.region)})`,
      points: app.traffic.series('node', n.id, since, 120),
      rxBps: n.rxBps,
      txBps: n.txBps,
      peers: n.peers,
      /** 今日字节（账本口径，与「累计流量」同一份数据） */
      today: ledgerOf('node').get(n.id) ?? { rxBytes: 0, txBytes: 0 },
    }));

    /**
     * 按房间归因：中继侧只看到网络名，这里补上房间 ID 与显示名，
     * 否则「每个房间用了多少流量」这个关键视图就没法呈现（之前只在 WS 推送里做了映射）。
     *
     * **口径是全网**：所有刚心跳过的子节点上报的网络，按网络名去重合并
     * （同一个房间被两个区域的节点同时带着时会合并成一条，标注来源数）。
     * 主控不再自带中继，所以这里没有"主控那一份"了。
     */
    const foreignNetworks = mergeRelayedNetworks([], app.nodeService.relayingNetworks()).map((fn) => {
      const room = app.rooms.findByNetworkName(fn.networkName);
      return {
        networkName: fn.networkName,
        roomId: room?.id ?? null,
        roomName: room?.name ?? null,
        roomCode: room?.code ?? null,
        peerCount: fn.peers,
        rxBytes: fn.rxBytes,
        txBytes: fn.txBytes,
        rxBps: fn.rxBps,
        txBps: fn.txBps,
        /** 有几个子节点在转发它（1 = 只有一台；≥2 = 多台区域节点同时在带） */
        relaySources: fn.relaySources,
      };
    });

    return {
      since,
      platform: {
        points: platformPoints,
        /** 全网聚合：转发全在子节点上，所以它就是子节点之和 */
        rxBps: nodeBps.rxBps,
        txBps: nodeBps.txBps,
        /**
         * 主控不再自带中继（2026-09-28 取消），累计字节没有单一来源可读，
         * 一律回 0；「今日/本月/累计」以 `totalsRange` 的账本口径为准。
         */
        rxBytes: 0,
        txBytes: 0,
        /** 主控那一台已不存在，这两项恒为 0（字段保留，老前端不白屏） */
        masterRxBps: 0,
        masterTxBps: 0,
        nodesRxBps: nodeBps.rxBps,
        nodesTxBps: nodeBps.txBps,
        onlineRelayNodes: nodeBps.nodes,
      },
      foreignNetworks,
      rooms,
      nodes,
      /**
       * 按用户：今日字节 + 终身用量（`users.used_bytes`，配额判定也用它）。
       * 分摊方式见 services/traffic-ledger.ts 的 `#memberShares`：按成员上报的实时
       * 带宽占比把房间增量分给成员 —— EasyTier 的 foreign peer 列表只给 peer_id，
       * 拿不到"哪个成员用了多少"（upstream 的 `PeerInfo` 里 IP 字段是空的）。
       */
      users: (() => {
        const todayByUser = ledgerOf('user');
        return app.users
          .list({ limit: 200 })
          .rows.map((u) => ({
            id: u.id,
            username: u.username,
            displayName: u.display_name ?? u.username,
            todayRxBytes: todayByUser.get(u.id)?.rxBytes ?? 0,
            todayTxBytes: todayByUser.get(u.id)?.txBytes ?? 0,
            usedBytes: u.used_bytes,
            quotaBytes: u.quota_bytes,
          }))
          .filter((u) => u.usedBytes > 0 || u.todayRxBytes > 0 || u.todayTxBytes > 0);
      })(),
      /** 今日累计（页面顶部那两张卡片的真实数值） */
      totals: { rxBytes: todayBytes.rxBytes, txBytes: todayBytes.txBytes },
      totalsRange: {
        today: todayBytes,
        month: app.ledger.sum({ scope: 'platform', scopeId: 'all', sinceDay: monthStart }),
        all: app.ledger.sum({ scope: 'platform', scopeId: 'all' }),
      },
      /** 分钟桶字节（"每分钟走了多少"）与近 30 天（月视图） */
      bytes: app.ledger.bucketSeries({ scope: 'platform', scopeId: 'all', sinceBucket: bucketSince(minutes), limit: 480 }),
      days: app.ledger.daySeries(30),
    };
  }, { auth: true, admin: true });

  /* ---------------------------------------------------------- 群发公告 */

  /**
   * 群发邮件公告。
   *
   * 三个动作分开：GET 取预览（能发给多少人、为什么有人收不到）+ 进度，
   * POST 登记并启动（**立刻返回**，发送在后台分批跑），DELETE 中止。
   * 之所以启动与查询分开：主控有 110 秒请求看门狗，同步发几百封信必然被掐。
   *
   * 收件人可以筛：角色（全部/仅管理员/仅普通）、最近 N 天活跃、或手填用户名。
   * 筛选条件跟着 GET 一起传，页面上的"将发送给 N 人"就是按它算出来的。
   */
  router.get(Routes.adminBroadcast, (ctx) => {
    requireAdmin(ctx);
    return app.broadcast.preview(
      audienceFrom(ctx.query.get('roles') ?? undefined, ctx.query.get('activeDays') ?? undefined, ctx.query.get('usernames') ?? undefined),
    );
  }, { auth: true, admin: true });

  router.post(Routes.adminBroadcast, async (ctx) => {
    const auth = requireAdmin(ctx);
    const body = await ctx.body();
    try {
      const report = app.broadcast.start({
        subject: body.subject,
        body: body.body,
        actor: auth.userId,
        audience: audienceFrom(
          typeof body.roles === 'string' ? body.roles : undefined,
          typeof body.activeDays === 'number' || typeof body.activeDays === 'string' ? body.activeDays : undefined,
          Array.isArray(body.usernames) ? body.usernames.join(',') : typeof body.usernames === 'string' ? body.usernames : undefined,
        ),
      });
      if (!report) {
        // 不排队：误点两次不该把同一封信发两遍
        throw HttpError.conflict('已有群发任务在运行，请等它结束后再发');
      }
      return report;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw HttpError.badRequest(err instanceof Error ? err.message : String(err));
    }
  }, { auth: true, admin: true });

  router.delete(Routes.adminBroadcast, (ctx) => {
    requireAdmin(ctx);
    return { stopped: app.broadcast.stop() };
  }, { auth: true, admin: true });
  /* ---------------------------------------------------------- 审计 */

  router.get(Routes.adminAudit, (ctx) => {
    requireAdmin(ctx);
    const { limit, offset } = paging(ctx);
    return app.audit.list({
      action: ctx.query.get('action') ?? undefined,
      actorId: ctx.query.get('actorId') ?? undefined,
      limit,
      offset,
    });
  }, { auth: true, admin: true });

  /* ---------------------------------------------------------- 设置 */

  router.get(Routes.adminSettings, (ctx) => {
    requireAdmin(ctx);
    return {
      // 密码在这里被抹掉：只回 smtpPasswordSet
      settings: toPublicSettings(app.settings.current),
      defaults: toPublicSettings(DEFAULT_SETTINGS),
      mail: app.mailer.describe(),
      env: {
        relayPort: app.config.easytier.relayPort,
        relayNetworkWhitelist: app.config.easytier.relayNetworkWhitelist,
        registrationOpen: app.config.registrationOpen,
        smtpHost: app.config.smtp.host,
        smtpPort: app.config.smtp.port,
        smtpSecure: app.config.smtp.secure,
        smtpFrom: app.config.smtp.from,
        requireEmailVerification: app.config.smtp.requireVerification,
      },
    };
  }, { auth: true, admin: true });

  router.patch(Routes.adminSettings, async (ctx) => {
    const auth = requireAdmin(ctx);
    const body = await ctx.body();
    const patch: Partial<PlatformSettings> = {};
    const siteName = optStr(body, 'siteName', 60);
    if (siteName) patch.siteName = siteName;
    const siteTagline = optStr(body, 'siteTagline', 200);
    if (siteTagline) patch.siteTagline = siteTagline;
    const downloadUrl = optStr(body, 'clientDownloadUrl', 300);
    if (downloadUrl) patch.clientDownloadUrl = downloadUrl;
    const clientVersion = optStr(body, 'clientVersion', 40);
    if (clientVersion) patch.clientVersion = clientVersion;
    if ('registrationOpen' in body) patch.registrationOpen = body.registrationOpen !== false;
    if ('announcement' in body) patch.announcement = optStr(body, 'announcement', 300) ?? null;
    if ('clientSha256' in body) patch.clientSha256 = optStr(body, 'clientSha256', 128) ?? null;
    if ('defaultQuotaBytes' in body) {
      patch.defaultQuotaBytes = body.defaultQuotaBytes === null ? null : optInt(body, 'defaultQuotaBytes', 0, Number.MAX_SAFE_INTEGER) ?? null;
    }
    for (const key of ['defaultMaxRooms', 'defaultMaxPlayers', 'roomTtlMinutes', 'defaultCapacityPeers', 'relayBandwidthKbps'] as const) {
      if (key in body) {
        const value = optInt(body, key, 0, 100_000_000);
        if (value !== undefined) patch[key] = value;
      }
    }

    /* ---------------------------------------------------------- 邮件设置 */
    if ('requireEmailVerification' in body) {
      patch.requireEmailVerification = body.requireEmailVerification !== false;
    }
    // 空字符串是合法值（表示"清空这个字段"），所以不能用 optStr
    if ('smtpHost' in body) patch.smtpHost = stringField(body, 'smtpHost', 200);
    if ('smtpUser' in body) patch.smtpUser = stringField(body, 'smtpUser', 120);
    if ('smtpFrom' in body) patch.smtpFrom = stringField(body, 'smtpFrom', 200);
    const smtpPort = optInt(body, 'smtpPort', 1, 65535);
    if (smtpPort !== undefined) patch.smtpPort = smtpPort;
    const smtpSecure = stringField(body, 'smtpSecure', 16);
    if (smtpSecure !== undefined) {
      if (!['ssl', 'starttls', 'none'].includes(smtpSecure)) {
        throw HttpError.badRequest('加密方式只能是 ssl / starttls / none', { smtpSecure: '取值不合法' });
      }
      patch.smtpSecure = smtpSecure as SmtpEncryption;
    }
    const ttl = optInt(body, 'emailCodeTtlMinutes', 1, 1440);
    if (ttl !== undefined) patch.emailCodeTtlMinutes = ttl;
    /*
     * 密码是三态语义，必须区分开：
     *   不传字段  = 不要动现在的密码（控制台只显示"已设置"，不回显明文）
     *   null      = 清空
     *   非空字符串 = 改成这个
     * 如果按普通 optStr 处理，"不改密码"会被当成"清空密码"。
     */
    if ('smtpPassword' in body) {
      const raw = body.smtpPassword;
      if (raw === null) patch.smtpPassword = null;
      else if (typeof raw === 'string' && raw.trim().length > 0) patch.smtpPassword = raw.trim().slice(0, 200);
    }

    if (patch.smtpFrom !== undefined && patch.smtpFrom.length > 0) {
      const problem = emailProblem(patch.smtpFrom.replace(/^.*<([^>]+)>.*$/, '$1'));
      if (problem) throw HttpError.badRequest(`发件人不是合法邮箱：${problem}`, { smtpFrom: problem });
    }

    const settings = app.settings.update(patch);
    app.audit.write({
      actorType: 'admin',
      actorId: auth.userId,
      actorName: auth.username,
      action: 'settings.update',
      targetType: 'settings',
      // 别把 SMTP 密码写进审计日志
      detail: redactPatch(patch),
      ip: ctx.ip,
    });
    return { settings: toPublicSettings(settings), mail: app.mailer.describe() };
  }, { auth: true, admin: true });

  /* ---------------------------------------------------------- 邮件排障 */

  router.get(Routes.adminMailStatus, (ctx) => {
    requireAdmin(ctx);
    return { ...app.mailer.describe(), recent: app.mailer.recent() };
  }, { auth: true, admin: true });

  /**
   * 发测试邮件。
   * 注意：**发失败也返回 200** —— 这是一次"诊断"，不是一次业务提交，
   * 失败时最有用的是 SMTP 会话原文，用 5xx 把它包进 error.message 里反而丢了。
   */
  router.post(Routes.adminMailTest, async (ctx) => {
    const auth = requireAdmin(ctx);
    const body = await ctx.body();
    const to = req(body, 'to', '收件邮箱');
    const problem = emailProblem(to);
    if (problem) throw HttpError.badRequest(problem, { to: problem });

    const attempt = await app.mailer.sendTest(to);
    app.audit.write({
      actorType: 'admin',
      actorId: auth.userId,
      actorName: auth.username,
      action: attempt.ok ? 'settings.mail_test_ok' : 'settings.mail_test_failed',
      targetType: 'settings',
      detail: { to, error: attempt.error },
      ip: ctx.ip,
    });
    return attempt;
  }, { auth: true, admin: true });

  /* ---------------------------------------------------------- 房间排障 */

  /** 强制按当前策略重算所有房间的 ACL（用于排障） */
  router.post('/admin/rooms/recompute-acl', (ctx) => {
    const auth = requireAdmin(ctx);
    const rows = app.rooms.listAll({ status: 'open', limit: 200 }).rows;
    for (const row of rows) app.roomService.bumpAcl(row.id);
    app.audit.write({
      actorType: 'admin',
      actorId: auth.userId,
      actorName: auth.username,
      action: 'room.recompute_acl',
      detail: { count: rows.length },
      ip: ctx.ip,
    });
    return { ok: true, count: rows.length };
  }, { auth: true, admin: true });
}

/**
 * 生成子节点部署命令：**一条命令**，复制到目标机器粘贴执行即可。
 *
 * 主控现在自己托管 `deploy/install-node.sh` 与 `deploy/agent.mjs`
 * （见 Routes.agentInstallScript / Routes.agentScript），所以目标机器不需要先拿到仓库，
 * 也不需要 scp —— 这是「一键探针」与「先拷文件再装」的区别。
 *
 * 命令里带齐了：主控地址、一次性注册密钥、区域、节点名、运行端口、链接端口。
 * 链接端口进 endpoint（主控下发给客户端的就是它），运行端口单独给 —— 两者不同
 * 是 NAT / 端口映射部署的常态。
 */
function buildAgentCommand(
  app: App,
  key: string,
  options: {
    region?: string;
    name?: string;
    host?: string;
    listenPort?: number;
    connectPort?: number;
    /** 是否为国内节点：是则带上 GitHub 加速前缀，下载 EasyTier 不至于超时 */
    domestic?: boolean;
    githubProxy?: string;
  } = {},
): string {
  const base = app.config.publicBaseUrl || `http://${publicHostOf(app)}`;
  const listen = options.listenPort ?? app.config.easytier.relayPort;
  const connect = options.connectPort ?? listen;
  const region = options.region ?? 'cn-east';
  const name = options.name ?? 'relay-sh';
  // 没给主机名时留一个明显的占位符，让管理员知道必须替换
  const host = options.host ?? '<把这个换成子节点的公网域名或IP>';
  const parts = [
    `curl -fsSL ${base}/agent/install.sh | sudo bash -s --`,
    `--master ${base}`,
    `--key ${key}`,
    `--region ${region}`,
    `--name ${name}`,
    `--endpoint ${host}:${connect}`,
    `--listen-port ${listen}`,
  ];
  /*
   * 国内节点才带代理前缀。装的时候 EasyTier 的下载顺序是
   * 「本机已有 → 从主控取 → GitHub（此处加代理）」，所以只有当主控自己也没带
   * Linux 二进制时，这个前缀才会真正被用到 —— 但那时它就是能不能装上的分水岭。
   */
  if (options.domestic) {
    const proxy = normalizeGithubProxy(options.githubProxy);
    parts.push(`--github-proxy ${proxy}`);
  }
  return parts.join(' ');
}

/** 把用户填的代理前缀归一化成"以 / 结尾"的形式；空值回退到内置默认 */
function normalizeGithubProxy(raw: string | undefined): string {
  const value = (raw ?? '').trim() || DEFAULT_GITHUB_PROXY;
  return value.endsWith('/') ? value : `${value}/`;
}

/** 兜底用的"本机地址"：优先公网基础 URL 的主机名，其次回退中继公网主机 */
function publicHostOf(app: App): string {
  const fromRelay = app.config.easytier.relayPublicHost;
  if (fromRelay) return fromRelay;
  return `127.0.0.1:${app.config.port}`;
}

/**
 * 「更新指令」：在**已经装过**的节点上跑，把 agent / EasyTier 二进制 / systemd 单元
 * 刷到主控侧的最新版，然后重启服务。
 *
 * 为什么不需要注册密钥：`--update` 从 /etc/mclink/node.env 读回主控地址与节点参数、
 * 用已有的 /etc/mclink/node-token.json 保持身份，全程不碰注册流程。
 * 所以这条命令对运维是"零参数"的，复制粘贴就能用。
 */
function buildAgentUpdateCommand(app: App): string {
  const base = app.config.publicBaseUrl || `http://${publicHostOf(app)}`;
  return `curl -fsSL ${base}/agent/install.sh | sudo bash -s -- --update`;
}
