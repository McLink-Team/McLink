/** 房间接口（玩家侧）与房主管理操作 */
import { Routes, isKnownRegion, type RoomAccess, type RoomVisibility } from '@mclink/shared';
import type { App } from '../app.ts';
import type { Router } from '../http/kit.ts';
import { optBool, optInt, optStr, paging, parsePolicy, req, requireAuth } from './helpers.ts';
import { HttpError } from '../util/errors.ts';
import { logger } from '../logger.ts';
import { toPublicRoom, toRoom, toRoomForUser } from '../db/rooms.ts';
import { hashRoomPassword } from '../services/rooms.ts';
import { KEEP_PER_ROOM, MAX_BODY_CHARS, clampBody } from '../db/chat.ts';

/** 房间内每人每分钟的发言上限 */
const CHAT_PER_MINUTE = 20;

const log = logger('api:rooms');

export function registerRoomRoutes(router: Router, app: App): void {
  /** 创建房间 */
  router.post(Routes.rooms, async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await ctx.body();
    const name = req(body, 'name', '房间名称').slice(0, 32);
    const zone = optStr(body, 'zone', 24) ?? 'auto';
    if (!isKnownRegion(zone)) throw HttpError.badRequest(`未知区域: ${zone}`, { zone: '未知区域' });

    /**
     * 用户手选的节点（可空 = 自动调度）。
     *
     * 区域（zone）与节点是**两层**：zone 只是默认/筛选，节点才是真正的选择对象。
     * 这里只做"形状"校验（字符串、去重、上限），
     * 节点是否真的可用由 roomService 校验 —— 那里能拿到 `disabled`/`weight` 等状态，
     * 而且校验失败要**降级为自动**并回一条说明，而不是建房直接失败（不因为选错节点就挡住建房）。
     */
    const nodeIds = Array.isArray(body.nodeIds)
      ? [...new Set(body.nodeIds.filter((v): v is string => typeof v === 'string' && v.length > 0))].slice(0, 3)
      : [];

    const access = (optStr(body, 'access', 16) ?? 'open') as RoomAccess;
    if (!['open', 'password', 'approval'].includes(access)) {
      throw HttpError.badRequest('access 必须是 open/password/approval 之一');
    }
    const visibility = (optStr(body, 'visibility', 16) ?? 'public') as RoomVisibility;
    if (!['public', 'hidden'].includes(visibility)) {
      throw HttpError.badRequest('visibility 必须是 public/hidden 之一');
    }

    const result = app.roomService.create({
      userId: auth.userId,
      name,
      zone,
      nodeIds,
      access,
      visibility,
      password: optStr(body, 'password', 64) ?? null,
      policy: parsePolicy(body),
      listenPort: optInt(body, 'listenPort', 1024, 65535) ?? app.settings.current.relayPort,
      rpcPort: optInt(body, 'rpcPort', 1024, 65535) ?? undefined,
      ttlMinutes: 'ttlMinutes' in body ? optInt(body, 'ttlMinutes', 0, 60 * 24 * 30) ?? null : undefined,
      hostHint: ctx.req.headers.host ?? null,
    });
    log.info('房间创建成功', { room: result.room.id, name, zone });
    return result;
  }, { auth: true });

  /** 我的房间（我建的 + 我加入的） */
  router.get(Routes.rooms, (ctx) => {
    const auth = requireAuth(ctx);
    // 网络名只对房主保留：成员本来就会在票据里拿到它，但在列表里没必要出现
    const hosted = app.rooms.listMine(auth.userId).map((row) => toRoomForUser(row, auth.userId));
    const joined = app.rooms
      .listJoined(auth.userId)
      .filter((r) => r.host_user_id !== auth.userId)
      .map((row) => toRoomForUser(row, auth.userId));
    return { hosted, joined };
  }, { auth: true });

  /** 公开房间大厅（匿名可访问，必须剥掉网络名等凭证字段） */
  router.get(Routes.roomPublic, (ctx) => {
    const { limit, offset } = paging(ctx, 40);
    const result = app.rooms.listPublic({
      zone: ctx.query.get('zone') ?? undefined,
      search: ctx.query.get('search') ?? undefined,
      limit,
      offset,
    });
    return { rooms: result.rows.map(toPublicRoom), total: result.total };
  });

  /** 凭加入码进房 */
  router.post(Routes.roomJoin, async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await ctx.body();
    const result = app.roomService.join({
      userId: auth.userId,
      code: req(body, 'code', '加入码').toUpperCase(),
      password: optStr(body, 'password', 64) ?? null,
      deviceName: optStr(body, 'deviceName', 32) ?? null,
      listenPort: optInt(body, 'listenPort', 1024, 65535) ?? app.settings.current.relayPort,
      rpcPort: optInt(body, 'rpcPort', 1024, 65535) ?? undefined,
      hostHint: ctx.req.headers.host ?? null,
    });
    return result;
  }, { auth: true });

  /** 房间详情：必须是房间成员（或房主）才能看，否则任意登录用户都能拿到加入码与成员 IP */
  router.get('/rooms/:id', (ctx) => {
    const auth = requireAuth(ctx);
    const roomId = ctx.params.id ?? '';
    const row = app.roomService.getRow(roomId);
    app.roomService.assertMember(row, auth.userId);
    return {
      room: toRoomForUser(row, auth.userId),
      members: app.roomService.members(roomId),
      usage: app.rooms.usage(roomId) ?? { rxBytes: 0, txBytes: 0, peers: 0 },
      isHost: auth.userId === row.host_user_id,
    };
  }, { auth: true });

  /** 客户端票据：包含启动 EasyTier 所需的网络身份与中继列表 */
  router.get('/rooms/:id/ticket', (ctx) => {
    const auth = requireAuth(ctx);
    const listenPort = Number.parseInt(ctx.query.get('listenPort') ?? '', 10);
    const rpcPort = Number.parseInt(ctx.query.get('rpcPort') ?? '', 10);
    return app.roomService.ticket(
      ctx.params.id ?? '',
      auth.userId,
      Number.isFinite(listenPort) && listenPort > 1024 ? listenPort : app.settings.current.relayPort,
      ctx.req.headers.host ?? null,
      // 只接受合法范围内的整数，其余交给服务端按 listenPort 推算
      Number.isFinite(rpcPort) ? rpcPort : null,
    );
  }, { auth: true });

  /** 房主专用：本地实例需要热应用的 ACL */
  router.get('/rooms/:id/acl', (ctx) => {
    const auth = requireAuth(ctx);
    const roomId = ctx.params.id ?? '';
    const row = app.roomService.getRow(roomId);
    app.roomService.assertHost(row, auth.userId);
    return { aclToml: app.roomService.aclToml(roomId), revision: row.acl_revision };
  }, { auth: true });

  /** 成员心跳：上报虚拟 IP、延迟、流量；同时拿到是否需要应用新 ACL / 是否被踢 */
  router.post('/rooms/:id/heartbeat', async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await ctx.body();
    const roomId = ctx.params.id ?? '';
    const peers = Array.isArray(body.peers)
      ? (body.peers as Array<Record<string, unknown>>).slice(0, 64).map((p) => ({
          ipv4: typeof p.ipv4 === 'string' ? p.ipv4 : '',
          cost: typeof p.cost === 'string' ? p.cost : '',
          latencyMs: typeof p.latencyMs === 'number' ? p.latencyMs : null,
        }))
      : undefined;

    const result = app.roomService.heartbeat(roomId, auth.userId, {
      virtualIp: optStr(body, 'virtualIp', 32) ?? null,
      deviceName: optStr(body, 'deviceName', 32) ?? null,
      peers,
      rxBps: optInt(body, 'rxBps', 0, 1e12) ?? 0,
      txBps: optInt(body, 'txBps', 0, 1e12) ?? 0,
      aclRevision: optInt(body, 'aclRevision', 0, Number.MAX_SAFE_INTEGER),
    });

    if (result.kicked) {
      return { kicked: true, aclToml: null, aclRevision: 0 };
    }
    return {
      kicked: false,
      // 只有房主需要 ACL；非房主恒为 null，避免把房间策略泄露给成员
      aclToml: result.aclToml,
      aclRevision: result.aclRevision,
    };
  }, { auth: true });

  /** 成员列表：同样只对房间成员开放 */
  router.get('/rooms/:id/members', (ctx) => {
    const auth = requireAuth(ctx);
    const roomId = ctx.params.id ?? '';
    app.roomService.assertMember(app.roomService.getRow(roomId), auth.userId);
    return app.roomService.members(roomId);
  }, { auth: true });

  /** 房主：审批加入申请 */
  router.post('/rooms/:id/members/approve', async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await ctx.body();
    const member = app.roomService.approve(
      ctx.params.id ?? '',
      auth.userId,
      req(body, 'userId', '用户 ID'),
      optBool(body, 'approve') !== false,
    );
    return member;
  }, { auth: true });

  /** 房主：踢人 */
  router.post('/rooms/:id/kick', async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await ctx.body();
    const result = app.roomService.kick(
      ctx.params.id ?? '',
      auth.userId,
      req(body, 'userId', '用户 ID'),
      optStr(body, 'reason', 80) ?? '房主移出',
    );
    return result;
  }, { auth: true });

  /** 房主：修改房间设置与策略 */
  router.patch('/rooms/:id', async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await ctx.body();
    const roomId = ctx.params.id ?? '';
    const row = app.roomService.getRow(roomId);
    app.roomService.assertHost(row, auth.userId);

    const patch: Parameters<typeof app.rooms.updateSettings>[1] = {};
    const name = optStr(body, 'name', 32);
    if (name) patch.name = name;
    const access = optStr(body, 'access', 16);
    if (access && ['open', 'password', 'approval'].includes(access)) patch.access = access as RoomAccess;
    const visibility = optStr(body, 'visibility', 16);
    if (visibility && ['public', 'hidden'].includes(visibility)) patch.visibility = visibility as RoomVisibility;
    const zone = optStr(body, 'zone', 24);
    if (zone && isKnownRegion(zone)) {
      patch.zone = zone;
      // 切换区域时重新调度中继
      patch.relayNodeIds = app.roomService.scheduleRelays(zone);
    }
    if ('password' in body) {
      const pw = optStr(body, 'password', 64);
      patch.passwordHash = pw ? hashRoomPassword(pw) : null;
    }
    app.rooms.updateSettings(roomId, patch);

    // 策略变更需要重算 ACL 并递增版本
    let aclToml: string | null = null;
    let revision = row.acl_revision;
    /**
     * 这个清单决定「哪些字段算策略变更」——漏掉一个键，只带该键的 PATCH 就会
     * 静默丢弃（走进 else 分支，只递增 ACL 版本，策略原封不动）。
     * allowBroadcast 曾经就漏在这里：房主单独打开广播直通没有任何效果。
     */
    const POLICY_KEYS = [
      'maxPlayers',
      'maxBandwidthKbps',
      'perMemberKbps',
      'rateLimitPps',
      'allowP2p',
      'allowBroadcast',
      'allowedPorts',
      'strictPorts',
      'motd',
      'allowPublicRelay',
    ];
    if (Object.keys(body).some((k) => POLICY_KEYS.includes(k))) {
      const current = toRoom(app.roomService.getRow(roomId));
      const policy = parsePolicy(body, current.policy);
      const updated = app.roomService.updatePolicy(roomId, auth.userId, policy);
      aclToml = updated.aclToml;
      revision = updated.revision;
    } else {
      revision = app.roomService.bumpAcl(roomId);
      aclToml = app.roomService.aclToml(roomId);
    }

    return { room: toRoom(app.roomService.getRow(roomId)), aclToml, revision };
  }, { auth: true });

  /** 房主：关闭房间 */
  router.post('/rooms/:id/close', (ctx) => {
    const auth = requireAuth(ctx);
    const roomId = ctx.params.id ?? '';
    app.roomService.close(roomId, auth.userId);
    return { ok: true };
  }, { auth: true });

  /** 房主：轮换网络密钥 */
  router.post('/rooms/:id/rotate-secret', (ctx) => {
    const auth = requireAuth(ctx);
    return app.roomService.rotateSecret(ctx.params.id ?? '', auth.userId);
  }, { auth: true });

  /** 主动退出房间 */
  router.post('/rooms/:id/leave', (ctx) => {
    const auth = requireAuth(ctx);
    app.roomService.leave(ctx.params.id ?? '', auth.userId);
    return { ok: true };
  }, { auth: true });

  /** 房间访问日志（房主可见） */
  router.get('/rooms/:id/access-log', (ctx) => {
    const auth = requireAuth(ctx);
    const roomId = ctx.params.id ?? '';
    app.roomService.assertHost(app.roomService.getRow(roomId), auth.userId);
    return app.rooms.recentAccess(roomId, 100);
  }, { auth: true });

  /* ------------------------------------------------------------ 房间聊天 */

  /** 取历史消息；带 sinceId 时做增量补齐（重连场景） */
  router.get('/rooms/:id/messages', (ctx) => {
    const auth = requireAuth(ctx);
    const roomId = ctx.params.id ?? '';
    app.roomService.assertMember(app.roomService.getRow(roomId), auth.userId);
    const sinceId = Number.parseInt(ctx.query.get('sinceId') ?? '', 10);
    const limit = Number.parseInt(ctx.query.get('limit') ?? '', 10);
    return {
      messages: app.messages.list(roomId, {
        sinceId: Number.isFinite(sinceId) ? sinceId : undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
      }),
      keepPerRoom: KEEP_PER_ROOM,
      maxBodyChars: MAX_BODY_CHARS,
    };
  }, { auth: true });

  /** 发消息。只允许房间成员，且按「每人每房间每分钟」限流，避免刷屏。 */
  router.post('/rooms/:id/messages', async (ctx) => {
    const auth = requireAuth(ctx);
    const roomId = ctx.params.id ?? '';
    const row = app.roomService.getRow(roomId);
    app.roomService.assertMember(row, auth.userId);
    if (row.status !== 'open') throw HttpError.conflict('房间已关闭，无法发言');

    const body = await ctx.body();
    const raw = typeof body.body === 'string' ? body.body : '';
    // 去掉纯换行/空白内容，避免空消息占位
    const trimmed = raw.replace(/\s+$/g, '').replace(/^\s+/, '');
    if (trimmed.length === 0) throw HttpError.badRequest('消息内容不能为空', { body: '消息内容不能为空' });

    const recent = app.messages.countRecentByUser(roomId, auth.userId, 60);
    if (recent >= CHAT_PER_MINUTE) {
      throw HttpError.rateLimited(`发言过于频繁（每分钟最多 ${CHAT_PER_MINUTE} 条）`);
    }

    const message = app.messages.add({
      roomId,
      userId: auth.userId,
      displayName: auth.displayName || auth.username,
      role: row.host_user_id === auth.userId ? 'host' : 'member',
      kind: 'text',
      body: clampBody(trimmed),
    });
    app.messages.trim(roomId);
    app.events.emit('room.message', { roomId, message });
    return message;
  }, { auth: true });

  /** 删除消息：房主可删本房间任意消息，其他人只能删自己的 */
  router.delete('/rooms/:id/messages/:messageId', (ctx) => {
    const auth = requireAuth(ctx);
    const roomId = ctx.params.id ?? '';
    const row = app.roomService.getRow(roomId);
    app.roomService.assertMember(row, auth.userId);

    const messageId = Number.parseInt(ctx.params.messageId ?? '', 10);
    if (!Number.isFinite(messageId)) throw HttpError.badRequest('消息 ID 不合法');
    const target = app.messages.findById(messageId);
    if (!target || target.room_id !== roomId) throw HttpError.notFound('消息不存在');

    const isHost = row.host_user_id === auth.userId;
    if (!isHost && target.user_id !== auth.userId) {
      throw HttpError.forbidden('只能删除自己的消息');
    }
    app.messages.remove(messageId);
    app.events.emit('room.messageDeleted', { roomId, messageId });
    if (isHost && target.user_id !== auth.userId) {
      app.audit.write({
        actorType: 'user',
        actorId: auth.userId,
        actorName: auth.username,
        action: 'room.chat_delete',
        targetType: 'room',
        targetId: roomId,
        detail: { messageId, author: target.display_name },
      });
    }
    return { ok: true };
  }, { auth: true });
}
