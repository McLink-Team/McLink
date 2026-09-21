/** 管理员接口：仪表盘、节点管理、房间管理、用户管理、流量、审计、中继控制 */
import { Routes, emailProblem, regionLabel, type PlatformSettings, type SmtpEncryption } from '@mclink/shared';
import type { App } from '../app.ts';
import type { Router } from '../http/kit.ts';
import { optInt, optStr, paging, req, requireAdmin } from './helpers.ts';
import { HttpError } from '../util/errors.ts';
import { logger } from '../logger.ts';
import { toNode } from '../db/nodes.ts';
import { toRoom } from '../db/rooms.ts';
import { enrollKey as makeEnrollKey } from '../util/id.ts';
import { buildOverview } from './public.ts';
import { DEFAULT_SETTINGS, toPublicSettings } from '../services/settings.ts';
import { SCHEMA_VERSION } from '../db/schema.ts';

const log = logger('api:admin');

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
 * EasyTier 的网络白名单是「空格分隔的 wildmatch 模式串」。
 * 语义上是列表，但配置里存成字符串；这里统一切成数组给前端用。
 */
function splitPatterns(value: string): string[] {
  return value.split(/\s+/).filter((s) => s.length > 0);
}

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
      users: { ...overview.users, online: app.runtime.onlineUserCount?.() ?? 0 },
      relay: {
        ...relay,
        version: app.relay.cliVersion,
        cliAvailable,
        /**
         * whitelist 是 EasyTier 的「空格分隔的模式列表」，语义上是数组。
         * 这里保留原始字符串（向后兼容）并额外给出已切分的数组，
         * 避免前端对字符串调用 .join() 直接渲染期崩溃。
         */
        whitelist: app.config.easytier.relayNetworkWhitelist,
        whitelistPatterns: splitPatterns(app.config.easytier.relayNetworkWhitelist),
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

    // 按房间归因：中继侧只看到网络名，这里补上房间 ID 与显示名，
    // 否则「每个房间用了多少流量」这个关键视图就没法呈现（之前只在 WS 推送里做了映射）
    const foreignNetworks = (sample?.foreignNetworks ?? []).map((fn) => {
      const room = app.rooms.findByNetworkName(fn.networkName);
      return {
        ...fn,
        roomId: fn.roomId ?? room?.id ?? null,
        roomName: room?.name ?? null,
        roomCode: room?.code ?? null,
      };
    });

    return {
      since,
      platform: {
        points: platformPoints,
        rxBps: sample?.rxBps ?? 0,
        txBps: sample?.txBps ?? 0,
        rxBytes: sample?.totalRxBytes ?? 0,
        txBytes: sample?.totalTxBytes ?? 0,
      },
      foreignNetworks,
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
      whitelistPatterns: splitPatterns(app.config.easytier.relayNetworkWhitelist),
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

/**
 * 生成子节点部署命令，管理员直接复制到目标机器执行。
 *
 * 注意不要在这里指向某个 HTTP 静态资源：主控只托管前端产物与 /downloads，
 * 并没有 /agent/install.sh 这个文件（早期版本这样写会给出一个 404 的命令）。
 * 这里改为「把仓库里的部署脚本拷过去再执行」，与 deploy/README.md 保持一致。
 */
function buildAgentCommand(app: App, key: string): string {
  const base = app.config.publicBaseUrl || `http://<主控地址>:${app.config.port}`;
  return [
    '# 1) 把仓库里的子节点安装脚本拷到目标机器（与主控同版本）',
    '#    scp deploy/install-node.sh deploy/agent.mjs root@<子节点IP>:/root/',
    '# 2) 在子节点上执行：',
    `sudo bash install-node.sh \\`,
    `  --master ${base} \\`,
    `  --key ${key} \\`,
    '  --region cn-east \\',
    '  --endpoint relay-sh.example.com:11010',
  ].join('\n');
}
