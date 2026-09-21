/** 管理员接口：仪表盘、节点管理、房间管理、用户管理、流量、审计、中继控制 */
import { Routes, regionLabel, type PlatformSettings } from '@mclink/shared';
import type { App } from '../app.ts';
import type { Router } from '../http/kit.ts';
import { optInt, optStr, paging, requireAdmin } from './helpers.ts';
import { HttpError } from '../util/errors.ts';
import { logger } from '../logger.ts';
import { toNode } from '../db/nodes.ts';
import { toRoom } from '../db/rooms.ts';
import { enrollKey as makeEnrollKey } from '../util/id.ts';
import { buildOverview } from './public.ts';
import { DEFAULT_SETTINGS } from '../services/settings.ts';
import { SCHEMA_VERSION } from '../db/schema.ts';

const log = logger('api:admin');

export function registerAdminRoutes(router: Router, app: App): void {
  /* ---------------------------------------------------------- 仪表盘 */

  router.get(Routes.adminOverview, (ctx) => {
    requireAdmin(ctx);
    const overview = buildOverview(app);
    const recentAudit = app.audit.recent(15);
    const nodes = app.nodeService.list();
    const rooms = app.rooms.listAll({ status: 'open', limit: 20 }).rows.map(toRoom);
    const relay = app.relay.status();
    const cliAvailable = app.relay.cliVersion !== null;

    return {
      ...overview,
      users: { ...overview.users, online: 0 },
      relay: {
        ...relay,
        version: app.relay.cliVersion,
        cliAvailable,
        whitelist: app.config.easytier.relayNetworkWhitelist,
        port: app.config.easytier.relayPort,
        rpcPortal: app.relay.rpcPortal,
        binary: app.config.easytier.coreBin,
        logFile: app.relay.logFilePath,
        configFile: app.relay.configFilePath,
      },
      system: {
        nodeVersion: process.version,
        platform: `${process.platform}/${process.arch}`,
        schemaVersion: SCHEMA_VERSION,
        dbFile: app.db.file,
        pid: process.pid,
        memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      },
      nodes: nodes.slice(0, 12),
      rooms: rooms.slice(0, 12),
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
    return {
      enrollKey: key,
      note: row.note,
      createdAt: row.created_at,
      /** 节点侧一键注册命令，直接贴到 Debian 上执行 */
      command: buildAgentCommand(app, key),
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

  router.patch('/admin/nodes/:id', async (ctx) => {
    const auth = requireAdmin(ctx);
    const body = await ctx.body();
    const node = app.nodeService.update(ctx.params.id ?? '', {
      name: optStr(body, 'name', 40),
      region: optStr(body, 'region', 24),
      endpoint: optStr(body, 'endpoint', 120),
      weight: optInt(body, 'weight', 0, 100000),
      capacityPeers: optInt(body, 'capacityPeers', 10, 100_000),
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
    const sample = app.relay.latest();

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
              rxBytes: usage?.rxBytes ?? 0,
              txBytes: usage?.txBytes ?? 0,
              peers: usage?.peers ?? 0,
            };
          });

    const nodes = app.nodeService.list().map((n) => ({
      id: n.id,
      label: `${n.name} (${regionLabel(n.region)})`,
      points: app.traffic.series('node', n.id, since, 120),
      rxBps: n.rxBps,
      txBps: n.txBps,
      peers: n.peers,
    }));

    return {
      since,
      platform: {
        points: platformPoints,
        rxBps: sample?.rxBps ?? 0,
        txBps: sample?.txBps ?? 0,
        rxBytes: sample?.totalRxBytes ?? 0,
        txBytes: sample?.totalTxBytes ?? 0,
      },
      foreignNetworks: sample?.foreignNetworks ?? [],
      rooms,
      nodes,
      totals: app.traffic.todayTotals(),
    };
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
      settings: app.settings.current,
      defaults: DEFAULT_SETTINGS,
      env: {
        relayPort: app.config.easytier.relayPort,
        relayNetworkWhitelist: app.config.easytier.relayNetworkWhitelist,
        registrationOpen: app.config.registrationOpen,
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

    const settings = app.settings.update(patch);
    app.audit.write({
      actorType: 'admin',
      actorId: auth.userId,
      actorName: auth.username,
      action: 'settings.update',
      targetType: 'settings',
      detail: patch,
      ip: ctx.ip,
    });
    return settings;
  }, { auth: true, admin: true });

  /* ---------------------------------------------------------- 中继 */

  router.get(Routes.adminRelay, (ctx) => {
    requireAdmin(ctx);
    const sample = app.relay.latest();
    return {
      runtime: app.relay.status(),
      configToml: app.relay.renderConfig(),
      configFile: app.relay.configFilePath,
      logFile: app.relay.logFilePath,
      cliVersion: app.relay.cliVersion,
      coreBin: app.config.easytier.coreBin,
      cliBin: app.config.easytier.cliBin,
      peers: sample?.peers ?? [],
      logs: app.relay.recentLogs(150),
      whitelist: app.config.easytier.relayNetworkWhitelist,
    };
  }, { auth: true, admin: true });

  router.post(Routes.adminRelayRestart, async (ctx) => {
    const auth = requireAdmin(ctx);
    const runtime = await app.relay.restart();
    app.audit.write({
      actorType: 'admin',
      actorId: auth.userId,
      actorName: auth.username,
      action: 'relay.restart',
      targetType: 'relay',
      ip: ctx.ip,
    });
    log.warn('管理员重启了主控中继', { by: auth.username });
    return runtime;
  }, { auth: true, admin: true });

  router.post(Routes.adminRelayAcl, async (ctx) => {
    const auth = requireAdmin(ctx);
    const body = await ctx.body();
    const aclToml = optStr(body, 'aclToml', 20000);
    if (!aclToml || !aclToml.includes('[acl.acl_v1]')) {
      throw HttpError.badRequest('aclToml 必须包含 [acl.acl_v1] 段');
    }
    const result = await app.relay.applyAcl(aclToml);
    app.audit.write({
      actorType: 'admin',
      actorId: auth.userId,
      actorName: auth.username,
      action: 'relay.acl_set',
      targetType: 'relay',
      detail: { bytes: aclToml.length, mode: result.mode },
      ip: ctx.ip,
    });
    return { ok: true, mode: result.mode };
  }, { auth: true, admin: true });

  router.post('/admin/relay/refresh', async (ctx) => {
    requireAdmin(ctx);
    const sample = await app.relay.sample();
    return { ok: Boolean(sample), peers: sample?.peerCount ?? 0, foreignNetworks: sample?.foreignNetworks.length ?? 0 };
  }, { auth: true, admin: true });

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

/** 生成子节点一键部署命令，管理员直接复制到目标机器 */
function buildAgentCommand(app: App, key: string): string {
  const base = app.config.publicBaseUrl || `http://<主控地址>:${app.config.port}`;
  return [
    'curl -fsSL ' + `${base}/agent/install.sh | sudo bash -s -- \\`,
    `  --master ${base} \\`,
    `  --key ${key} \\`,
    '  --region cn-east \\',
    '  --endpoint relay-sh.example.com:11010',
  ].join('\n');
}
