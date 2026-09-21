/**
 * 房间服务：房间生命周期、成员、票据（客户端启动 EasyTier 所需的全部信息）。
 *
 * 「单端口多房间隔离」在这里落地：
 *   每个房间 = 一个独立的 EasyTier 网络（network_name 随机 + network_secret 32 位随机），
 *   客户端全部连接主控的同一个端口；因为网络身份不同，房间之间无法互相发现或通信。
 */
import {
  DEFAULT_ROOM_POLICY,
  ErrorCodes,
  allocateSeat,
  allocateSlot,
  hostIpCidr,
  memberIpCidr,
  subnetForSlot,
  generateRoomCode,
  generateNetworkSecret,
  kbpsToBytesPerSecond,
  type Room,
  type RoomAccess,
  type RoomMember,
  type RoomPolicy,
  type RoomTicket,
  type RoomVisibility,
  type RelayEndpoint,
} from '@mclink/shared';
import { createHash } from 'node:crypto';
import type { ServerConfig } from '../config.ts';
import type { AppEventBus } from '../app.ts';
import { HttpError } from '../util/errors.ts';
import { logger } from '../logger.ts';
import { randomBytesBuf, shortId } from '../util/id.ts';
import { buildLaunchArgs, renderAcl, renderEasytierToml, rpcPortalForListenPort, CONFIG_PLACEHOLDER, type AclSpec } from '../easytier/config.ts';
import { buildRoomAcl } from '../easytier/acl.ts';
import { RoomRepo, toMember, toRoom, toRoomForUser, type JoinedRoomRow, type MemberRow } from '../db/rooms.ts';
import { NodeRepo, type NodeRow } from '../db/nodes.ts';
import { UserRepo } from '../db/users.ts';
import { AuditRepo } from '../db/traffic.ts';
import type { SettingsService } from './settings.ts';

const log = logger('rooms');

/** 房间状态变化后统一广播，避免每个分支各写一遍 */
function notifyChanged(events: AppEventBus, roomId: string): void {
  events.emit('room.changed', roomId);
}

/**
 * 由房间密钥派生出网络名。
 *
 * 为什么网络名本身必须不可猜测（这是一个必须踩过一次才会知道的设计点）：
 * EasyTier 的公共中继按**网络名**决定是否为某个外来网络中继（relay_network_whitelist），
 * 而 `network_secret` 只有在开启 `private_mode` 时才会被校验
 * （见 easytier-core/src/peers/peer_manager.rs: `foreign_network_allowed` 那段）。
 * 但 `private_mode` 对共享中继是不可用的——中继自身的密钥与任何房间都不同，
 * 打开它会把所有房间一起拒之门外。
 *
 * 结论：在「单端口共享中继」这个架构下，**网络名就是准入凭证**。
 * 因此这里用密钥派生出 128 bit 随机网络名，并把密钥单独保留：
 *   - 不知道网络名的客户端连中继都不会被转发；
 *   - 由于网络名由密钥派生，轮换密钥会同时换掉网络名，
 *     旧成员/被踢者手里的名字立刻失效（比单纯换密码更彻底）。
 */
export function deriveNetworkName(secret: string): string {
  const digest = createHash('sha256').update(`mclink-net-v1:${secret}`).digest('hex');
  return `mclink-room-${digest.slice(0, 32)}`;
}

export interface CreateRoomInput {
  userId: string;
  name: string;
  zone?: string;
  access?: RoomAccess;
  visibility?: RoomVisibility;
  password?: string | null;
  policy?: Partial<RoomPolicy>;
  /** 客户端选择的本地监听端口，用于生成配置 */
  listenPort?: number;
  ttlMinutes?: number | null;
  /** 请求的 Host 头，用于在未显式配置公网地址时推导主控中继地址 */
  hostHint?: string | null;
}

export interface JoinResult {
  room: Room;
  member: RoomMember;
  ticket: RoomTicket | null;
  pending: boolean;
}

export class RoomService {
  private readonly config: ServerConfig;
  private readonly rooms: RoomRepo;
  private readonly nodes: NodeRepo;
  private readonly users: UserRepo;
  private readonly audit: AuditRepo;
  private readonly settings: SettingsService;
  private readonly events: AppEventBus;

  constructor(
    config: ServerConfig,
    rooms: RoomRepo,
    nodes: NodeRepo,
    users: UserRepo,
    audit: AuditRepo,
    settings: SettingsService,
    events: AppEventBus,
  ) {
    this.config = config;
    this.rooms = rooms;
    this.nodes = nodes;
    this.users = users;
    this.audit = audit;
    this.settings = settings;
    this.events = events;
  }

  /* ------------------------------------------------------------ 查询 */

  getRow(roomId: string): JoinedRoomRow {
    const row = this.rooms.findById(roomId);
    if (!row) throw HttpError.notFound('房间不存在');
    return row;
  }

  getRoom(roomId: string): Room {
    return toRoom(this.getRow(roomId));
  }

  assertHost(room: JoinedRoomRow, userId: string): void {
    if (room.host_user_id !== userId) {
      throw HttpError.forbidden('只有房主可以执行该操作');
    }
  }

  /**
   * 断言调用者是该房间的房主或活跃成员。
   *
   * 为什么需要：`GET /rooms/:id` 与 `/rooms/:id/members` 早期只校验了「已登录」，
   * 于是任何登录用户只要拿到 roomId 就能读到加入码、成员列表与虚拟 IP。
   * 房间内容属于房间成员，不属于全体登录用户。
   */
  assertMember(room: JoinedRoomRow, userId: string): void {
    if (room.host_user_id === userId) return;
    const member = this.rooms.findMember(room.id, userId);
    if (!member || member.status !== 'active') {
      throw HttpError.forbidden('你不是该房间的成员');
    }
  }

  members(roomId: string): RoomMember[] {
    return this.rooms.listMembers(roomId).map(toMember);
  }

  /* ------------------------------------------------------------ 创建 */

  create(input: CreateRoomInput): JoinResult {
    const user = this.users.findById(input.userId);
    if (!user) throw HttpError.notFound('用户不存在');
    if (user.banned === 1) throw HttpError.forbidden('账号已被封禁');

    const s = this.settings.current;
    const maxRooms = user.max_rooms ?? s.defaultMaxRooms;
    if (maxRooms > 0 && this.rooms.countActiveByHost(input.userId) >= maxRooms) {
      throw HttpError.conflict(`最多同时创建 ${maxRooms} 个房间，请先关闭旧房间`);
    }

    const slot = allocateSlot(this.rooms.usedSlots());
    if (slot === null) {
      throw HttpError.unavailable('虚拟网段已耗尽，请联系管理员扩容');
    }

    const code = this.#uniqueCode();
    const policy: RoomPolicy = {
      ...DEFAULT_ROOM_POLICY,
      maxPlayers: Math.max(2, Math.min(input.policy?.maxPlayers ?? s.defaultMaxPlayers, 64)),
      ...input.policy,
    };

    const zone = input.zone && input.zone !== '' ? input.zone : 'auto';
    const relayNodeIds = this.scheduleRelays(zone);
    // 没有子节点时，主控自身中继仍可作为唯一入口，别让单机部署无法建房
    if (relayNodeIds.length === 0 && !this.masterRelayAvailable()) {
      throw HttpError.unavailable('当前没有可用的中继节点，请联系管理员');
    }

    const networkSecret = generateNetworkSecret(randomBytesBuf, 32);
    const networkName = deriveNetworkName(networkSecret);
    const ttlMinutes = input.ttlMinutes === undefined ? s.roomTtlMinutes : input.ttlMinutes;
    const expiresAt =
      ttlMinutes && ttlMinutes > 0 ? new Date(Date.now() + ttlMinutes * 60_000).toISOString() : null;

    const access: RoomAccess = input.access ?? 'open';
    if (access === 'password' && !input.password) {
      throw HttpError.badRequest('选择密码加入时必须设置房间密码');
    }

    const passwordHash = input.password ? hashRoomPassword(input.password) : null;

    const row = this.rooms.create({
      id: shortId('r'),
      code,
      name: input.name,
      hostUserId: input.userId,
      access,
      visibility: input.visibility ?? 'public',
      zone,
      relayNodeIds,
      policy,
      networkName,
      networkSecret,
      subnet: subnetForSlot(slot),
      subnetSlot: slot,
      passwordHash,
      expiresAt,
    });

    // 房主占 seat 0 → 网段 .1
    this.rooms.addMember({
      roomId: row.id,
      userId: input.userId,
      role: 'host',
      status: 'active',
      virtualIp: hostIpCidr(slot),
      seat: 0,
    });
    this.rooms.recalcCounts(row.id);
    notifyChanged(this.events, row.id);

    this.audit.write({
      actorType: 'user',
      actorId: input.userId,
      actorName: user.username,
      action: 'room.create',
      targetType: 'room',
      targetId: row.id,
      detail: { name: input.name, zone, access, slot, relayNodeIds },
    });
    log.info('房间已创建', { room: row.id, code, zone, slot, host: user.username });

    const fresh = this.rooms.findById(row.id)!;
    const member = this.rooms.findMember(row.id, input.userId)!;
    return {
      room: toRoomForUser(fresh, input.userId),
      member: toMember(member),
      ticket: this.ticket(
        row.id,
        input.userId,
        input.listenPort ?? this.settings.current.relayPort,
        input.hostHint,
      ),
      pending: false,
    };
  }

  /* ------------------------------------------------------------ 加入 */

  join(input: {
    userId: string;
    code: string;
    password?: string | null;
    deviceName?: string | null;
    listenPort?: number;
    hostHint?: string | null;
  }): JoinResult {
    const row = this.rooms.findByCode(input.code.toUpperCase());
    if (!row) throw HttpError.notFound('加入码无效');

    const user = this.users.findById(input.userId);
    if (!user) throw HttpError.notFound('用户不存在');
    if (user.banned === 1) throw HttpError.forbidden('账号已被封禁');
    if (row.status !== 'open') throw new HttpError(400, ErrorCodes.ROOM_CLOSED, '房间已关闭');
    if (row.expires_at && row.expires_at < new Date().toISOString()) {
      this.rooms.close(row.id, 'expired');
      throw new HttpError(400, ErrorCodes.ROOM_CLOSED, '房间已过期');
    }

    const existing = this.rooms.findMember(row.id, input.userId);
    if (existing && existing.status === 'kicked') {
      throw HttpError.forbidden('你已被房主移出该房间');
    }

    // 房主重复进入直接返回票据
    if (row.host_user_id === input.userId) {
      return {
        room: toRoom(row),
        member: toMember(existing ?? this.rooms.addMember({
          roomId: row.id,
          userId: input.userId,
          role: 'host',
          status: 'active',
          virtualIp: hostIpCidr(row.subnet_slot),
          seat: 0,
        })),
        ticket: this.ticket(row.id, input.userId, input.listenPort ?? this.settings.current.relayPort, input.hostHint),
        pending: false,
      };
    }

    const policy = toRoom(row).policy;    const activeCount = this.rooms.listMembers(row.id).filter((m) => m.status === 'active').length;
    if (activeCount >= policy.maxPlayers) {
      throw new HttpError(409, ErrorCodes.ROOM_FULL, `房间人数已满（${policy.maxPlayers} 人）`);
    }

    if (row.access === 'password') {
      if (!input.password) {
        throw new HttpError(401, ErrorCodes.ROOM_PASSWORD, '该房间需要密码');
      }
      if (!verifyRoomPassword(input.password, row.password_hash)) {
        this.rooms.logAccess(row.id, input.userId, 'password_fail', null, null);
        throw new HttpError(401, ErrorCodes.ROOM_PASSWORD, '房间密码错误');
      }
    }

    const seat = existing?.seat ?? allocateSeat(this.rooms.usedSeats(row.id));
    if (seat === null) throw new HttpError(409, ErrorCodes.ROOM_FULL, '房间座位已满');
    const virtualIp = memberIpCidr(row.subnet_slot, seat);
    const pending = row.access === 'approval' && existing?.status !== 'active';

    const member = this.rooms.addMember({
      roomId: row.id,
      userId: input.userId,
      role: 'member',
      status: pending ? 'pending' : 'active',
      virtualIp,
      seat,
      deviceName: input.deviceName ?? null,
    });
    this.rooms.recalcCounts(row.id);
    this.rooms.touch(row.id);
    this.rooms.logAccess(row.id, input.userId, pending ? 'join_pending' : 'join', null, null);
    notifyChanged(this.events, row.id);

    this.audit.write({
      actorType: 'user',
      actorId: input.userId,
      actorName: user.username,
      action: pending ? 'room.join_request' : 'room.join',
      targetType: 'room',
      targetId: row.id,
      detail: { seat, virtualIp },
    });
    log.info('成员加入房间', { room: row.id, user: user.username, seat, pending });

    const fresh = this.rooms.findById(row.id)!;
    return {
      // 待审批时连房间对象也不能带网络名，否则「审批」这道门形同虚设
      room: toRoomForUser(fresh, input.userId),
      member: toMember(member),
      ticket: pending
        ? null
        : this.ticket(row.id, input.userId, input.listenPort ?? this.settings.current.relayPort, input.hostHint),
      pending,
    };
  }

  /** 房主审批通过 */
  approve(roomId: string, hostUserId: string, targetUserId: string, approve: boolean): RoomMember {
    const row = this.getRow(roomId);
    this.assertHost(row, hostUserId);
    const member = this.rooms.findMember(roomId, targetUserId);
    if (!member) throw HttpError.notFound('该用户不在申请列表中');
    if (member.status !== 'pending') throw HttpError.conflict('该申请已被处理');

    if (approve) {
      this.rooms.updateMemberStatus(roomId, targetUserId, 'active');
      this.rooms.logAccess(roomId, targetUserId, 'approved', null, null);
    } else {
      this.rooms.removeMember(roomId, targetUserId, 'kicked');
      this.rooms.logAccess(roomId, targetUserId, 'rejected', null, null);
    }
    this.rooms.recalcCounts(roomId);
    const revision = this.bumpAcl(roomId);
    notifyChanged(this.events, roomId);
    this.events.emit('room.acl', { roomId, revision });
    this.audit.write({
      actorType: 'user',
      actorId: hostUserId,
      action: approve ? 'room.approve' : 'room.reject',
      targetType: 'room',
      targetId: roomId,
      detail: { targetUserId },
    });
    return toMember(this.rooms.findMember(roomId, targetUserId)!);
  }

  /* ------------------------------------------------------------ 踢人 */

  /**
   * 踢人：把成员标记为 kicked，并递增 ACL 版本。
   * 房主客户端会在下次心跳/推送中拿到新 ACL，用被踢成员的虚拟 IP 建一条 Drop 规则。
   */
  kick(roomId: string, hostUserId: string, targetUserId: string, reason = '房主移出'): { aclToml: string; revision: number } {
    const row = this.getRow(roomId);
    this.assertHost(row, hostUserId);
    if (targetUserId === hostUserId) throw HttpError.badRequest('房主不能踢出自己');
    const member = this.rooms.findMember(roomId, targetUserId);
    if (!member) throw HttpError.notFound('该用户不在房间内');

    this.rooms.removeMember(roomId, targetUserId, 'kicked');
    this.rooms.recalcCounts(roomId);
    this.rooms.logAccess(roomId, targetUserId, 'kicked', reason, null);
    const revision = this.bumpAcl(roomId);
    notifyChanged(this.events, roomId);
    this.events.emit('room.acl', { roomId, revision });
    // 立刻通知被踢的人断开，而不是等它下一次心跳
    this.events.emit('room.kicked', { roomId, userId: targetUserId, reason });
    this.audit.write({
      actorType: 'user',
      actorId: hostUserId,
      action: 'room.kick',
      targetType: 'room',
      targetId: roomId,
      detail: { targetUserId, reason },
    });
    log.info('成员被移出房间', { room: roomId, target: targetUserId, reason });
    return { aclToml: this.aclToml(roomId), revision };
  }

  /** 成员主动退出 */
  leave(roomId: string, userId: string): void {
    const row = this.rooms.findById(roomId);
    if (!row) return;
    if (row.host_user_id === userId) {
      // 房主退出 = 关闭房间
      this.close(roomId, userId, true);
      return;
    }
    this.rooms.removeMember(roomId, userId, 'left');
    this.rooms.recalcCounts(roomId);
    this.rooms.logAccess(roomId, userId, 'leave', null, null);
    const revision = this.bumpAcl(roomId);
    notifyChanged(this.events, roomId);
    this.events.emit('room.acl', { roomId, revision });
  }

  /* ------------------------------------------------------------ 关闭 */

  close(roomId: string, userId: string, byHost = false): void {
    const row = this.getRow(roomId);
    this.assertHost(row, userId);
    this.rooms.close(roomId, 'closed');
    this.rooms.logAccess(roomId, userId, 'close', byHost ? 'host' : 'api', null);
    this.events.emit('room.closed', roomId);
    notifyChanged(this.events, roomId);
    this.audit.write({
      actorType: 'user',
      actorId: userId,
      action: 'room.close',
      targetType: 'room',
      targetId: roomId,
      detail: { name: row.name },
    });
    log.info('房间已关闭', { room: roomId });
  }

  /**
   * 轮换房间网络身份。
   * 由于网络名由密钥派生，同时换掉网络名与密钥意味着：
   *   - 被踢者手里的旧网络名再也无法被中继转发；
   *   - 已泄露的票据彻底作废；
   *   - 房间加入码与成员列表保持不变，对正常玩家无感。
   */
  rotateSecret(roomId: string, userId: string): { networkName: string; secret: string; ticket: RoomTicket } {
    const row = this.getRow(roomId);
    this.assertHost(row, userId);
    const secret = generateNetworkSecret(randomBytesBuf, 32);
    const networkName = deriveNetworkName(secret);
    this.rooms.updateIdentity(roomId, networkName, secret);
    const revision = this.rooms.bumpAclRevision(roomId);
    notifyChanged(this.events, roomId);
    this.events.emit('room.acl', { roomId, revision });
    this.rooms.logAccess(roomId, userId, 'rotate_secret', null, null);
    this.audit.write({
      actorType: 'user',
      actorId: userId,
      action: 'room.rotate_secret',
      targetType: 'room',
      targetId: roomId,
      detail: { networkName },
    });
    log.info('房间网络身份已轮换', { room: roomId, networkName });
    return {
      networkName,
      secret,
      ticket: this.ticket(roomId, userId, this.settings.current.relayPort),
    };
  }

  updatePolicy(roomId: string, userId: string, policy: RoomPolicy): { room: Room; aclToml: string; revision: number } {
    const row = this.getRow(roomId);
    this.assertHost(row, userId);
    this.rooms.updatePolicy(roomId, policy);
    const revision = this.bumpAcl(roomId);
    notifyChanged(this.events, roomId);
    this.events.emit('room.acl', { roomId, revision });
    this.audit.write({
      actorType: 'user',
      actorId: userId,
      action: 'room.policy',
      targetType: 'room',
      targetId: roomId,
      detail: { policy },
    });
    return { room: this.getRoom(roomId), aclToml: this.aclToml(roomId), revision };
  }

  /* ------------------------------------------------------------ 票据 */

  /**
   * 主控自身中继端点。
   *
   * 它不在 relay_nodes 表里（那是「子节点」），但永远可用，因此把它作为
   * 票据里的兜底入口——这样只部署一台主控、还没铺子节点时也能正常联机。
   */
  masterRelayEndpoint(hostHint?: string | null): RelayEndpoint | null {
    const et = this.config.easytier;
    let host = et.relayPublicHost;
    if (!host && this.config.publicBaseUrl) {
      try {
        host = new URL(this.config.publicBaseUrl).hostname;
      } catch {
        /* publicBaseUrl 配置不合法时忽略，继续回退 */
      }
    }
    if (!host && hostHint) host = hostHint.split(':')[0] ?? '';
    if (!host) return null;
    return {
      nodeId: 'master',
      region: 'master',
      label: '主控中继（兜底）',
      url: `tcp://${host}:${et.relayPort}`,
      udpUrl: `udp://${host}:${et.relayPort}`,
      latencyMs: null,
    };
  }

  /** 主控中继是否被配置为可用（单机部署的最低要求） */
  masterRelayAvailable(): boolean {
    return this.config.autoStartRelay && this.config.easytier.relayPort > 0;
  }

  /** 生成客户端启动 EasyTier 所需的一切 */
  ticket(roomId: string, userId: string, listenPort: number, hostHint?: string | null): RoomTicket {
    const row = this.getRow(roomId);
    const member = this.rooms.findMember(roomId, userId);
    if (!member || member.status === 'kicked') {
      throw HttpError.forbidden('你不在该房间中');
    }
    if (member.status === 'pending') {
      throw HttpError.forbidden('等待房主审批');
    }

    const room = toRoom(row);
    const relayRows = this.nodes.findByIds(room.relayNodeIds);
    const relays: RelayEndpoint[] = relayRows.map((n) => {
      const host = n.endpoint.split(':')[0] ?? n.endpoint;
      const port = n.endpoint.split(':')[1] ?? String(this.settings.current.relayPort);
      return {
        nodeId: n.id,
        region: n.region,
        label: n.name,
        url: `tcp://${host}:${port}`,
        udpUrl: `udp://${host}:${port}`,
        latencyMs: null,
      };
    });

    const master = this.masterRelayEndpoint(hostHint);
    if (master && !relays.some((r) => r.url === master.url)) relays.push(master);

    const virtualIp = member.virtual_ip ?? hostIpCidr(room.subnetSlot);
    const hostMember = this.rooms.findMember(roomId, room.hostUserId);
    const hostVirtualIp = (hostMember?.virtual_ip ?? hostIpCidr(room.subnetSlot)).replace(/\/\d+$/, '');
    const isHost = room.hostUserId === userId;

    // 客户端启动时至少要有 1 个中继入口，否则无法加入虚拟网络
    const peers = relays.length > 0
      ? relays.flatMap((r) => [{ uri: r.url }, { uri: r.udpUrl }])
      : [];

    const configToml = renderEasytierToml({
      instanceName: `mclink-${room.code.toLowerCase()}`,
      hostname: member.device_name ?? member.username ?? 'mclink-client',
      ipv4: virtualIp,
      listeners: [`tcp://0.0.0.0:${listenPort}`, `udp://0.0.0.0:${listenPort}`],
      peers,
      // 用数据库行里的值：Room.networkName 现在是可选的（对玩家接口会剥掉），
      // 但票据是唯一有权携带网络名的地方，这里必须拿到确定的字符串
      networkName: row.network_name,
      networkSecret: row.network_secret,
      flags: {
        enableEncryption: true,
        enableIpv6: false,
        mtu: 1380,
        defaultProtocol: 'tcp',
        noTun: false,
        /**
         * 关闭 bind_device。
         *
         * EasyTier 默认 `bind_device = true`，会把隧道的出站套接字绑定到指定网卡；
         * 在部分环境（受限容器、多网卡、Windows 沙箱）下会直接报
         * WSAEADDRNOTAVAIL(10049) 而完全无法连接中继。中继与子节点都显式关闭了它，
         * 客户端必须保持一致，否则玩家会「连上主控却进不了房间」。
         */
        bindDevice: false,
        // 让 Minecraft 的局域网广播能跨虚拟网络，玩家在「多人游戏」里就能直接看到房间
        enableUdpBroadcastRelay: true,
        // 允许成员间直连；关闭后一律走中继
        disableP2p: !room.policy.allowP2p,
        /**
         * 实例级接收限速。
         *
         * EasyTier 只有「本实例接收」这一个可按实例设置的速率上限
         * （`instance_recv_bps_limit`）。注意它的单位是**字节/秒**，不是比特/秒
         * （见 packages/shared/src/format.ts 的 kbpsToBytesPerSecond 注释与 EasyTier 测试）。
         * 落到不同角色上语义不同：
         *   - 房主：所有成员→房主的流量都汇到这一个实例，所以它就是「房间上行入口总量」，
         *         用 policy.maxBandwidthKbps 约束（房间总带宽）。
         *   - 成员：约束的是该成员自己的下载速率，用 policy.perMemberKbps。
         * 取两者中较小的一个，避免房主既设了房间总限速又被单成员限速放宽。
         */
        ...(() => {
          const limits = [room.policy.perMemberKbps, isHost ? room.policy.maxBandwidthKbps : 0].filter(
            (v) => v > 0,
          );
          if (limits.length === 0) return {};
          return { instanceRecvBpsLimit: kbpsToBytesPerSecond(Math.min(...limits)) };
        })(),
        lazyP2p: false,
        multiThread: true,
      },
      consoleLogLevel: 'warn',
      acl: isHost ? this.buildAclSpec(roomId) : null,
    });

    return {
      roomId: room.id,
      roomCode: room.code,
      roomName: room.name,
      networkName: row.network_name,
      networkSecret: row.network_secret,
      virtualIp,
      hostVirtualIp,
      instanceName: `mclink-${room.code.toLowerCase()}`,
      mtu: 1380,
      relays,
      configToml,
      // 客户端只需把 %CONFIG% 换成它落盘的配置路径即可启动
      launchArgs: buildLaunchArgs({
        configFile: CONFIG_PLACEHOLDER,
        rpcPortal: `127.0.0.1:${rpcPortalForListenPort(listenPort)}`,
        rpcPortalWhitelist: ['127.0.0.1/32'],
      }),
      aclToml: isHost ? this.aclTomlFor(roomId, room) : null,
      // 统一用数据库里的单调递增版本号，客户端靠它判断「要不要重新应用 ACL」
      aclRevision: row.acl_revision,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    };
  }

  /** 房主实例应持有的 ACL（TOML） */
  aclToml(roomId: string): string {
    const room = this.getRoom(roomId);
    return this.aclTomlFor(roomId, room);
  }

  aclTomlFor(roomId: string, room: Room): string {
    const spec = this.buildAclSpec(roomId, room);
    return `${renderAcl(spec).join('\n')}\n`;
  }

  buildAclSpec(roomId: string, room?: Room): AclSpec {
    const target = room ?? this.getRoom(roomId);
    const hostMember = this.rooms.findMember(roomId, target.hostUserId);
    const hostIp = (hostMember?.virtual_ip ?? hostIpCidr(target.subnetSlot)).replace(/\/\d+$/, '');
    return buildRoomAcl({
      roomId,
      policy: target.policy,
      hostIp,
      blockedIps: this.blockedIps(roomId),
      memberCount: target.memberCount,
    });
  }

  blockedIps(roomId: string): string[] {
    const rows = this.rooms.listMembers(roomId, true).filter((m) => m.status === 'kicked');
    return rows
      .map((m) => m.virtual_ip)
      .filter((ip): ip is string => typeof ip === 'string' && ip.length > 0)
      .map((ip) => ip.replace(/\/\d+$/, ''));
  }

  /** 心跳：更新成员在线状态与流量，并返回是否被踢 */
  heartbeat(
    roomId: string,
    userId: string,
    payload: {
      virtualIp?: string | null;
      deviceName?: string | null;
      peers?: Array<{ ipv4: string; cost: string; latencyMs: number | null }>;
      rxBps?: number;
      txBps?: number;
      /** 客户端当前已应用的 ACL 版本；与房间当前版本一致时就不必再下发 ACL */
      aclRevision?: number;
    },
  ): { kicked: boolean; aclToml: string | null; aclRevision: number } {
    const member = this.rooms.findMember(roomId, userId);
    if (!member) return { kicked: true, aclToml: null, aclRevision: 0 };
    if (member.status === 'kicked') {
      return { kicked: true, aclToml: null, aclRevision: 0 };
    }

    // 从上报的 peer 列表里挑一条直连延迟，作为该成员的「体感延迟」
    let latency: number | null = null;
    let p2p = false;
    for (const peer of payload.peers ?? []) {
      if (peer.latencyMs !== null && peer.latencyMs !== undefined) {
        latency = latency === null ? peer.latencyMs : Math.min(latency, peer.latencyMs);
        p2p = true;
      }
    }

    this.rooms.updateMemberHeartbeat(roomId, userId, {
      virtualIp: payload.virtualIp ?? undefined,
      deviceName: payload.deviceName ?? undefined,
      latencyMs: latency,
      p2p,
      rxBps: payload.rxBps ?? 0,
      txBps: payload.txBps ?? 0,
    });
    this.rooms.touch(roomId);
    this.rooms.recalcCounts(roomId);

    const row = this.rooms.findById(roomId);
    const revision = row?.acl_revision ?? 0;
    const isHostOfRoom = row?.host_user_id === userId;
    // ACL 只在版本变化时下发：房主每 10 秒收一份近 1KB 的 ACL 是纯浪费
    const needsAcl = isHostOfRoom && payload.aclRevision !== revision;
    return {
      kicked: false,
      aclToml: needsAcl ? this.aclToml(roomId) : null,
      aclRevision: revision,
    };
  }

  /* ------------------------------------------------------------ 调度 */

  /**
   * 按区域挑选中继节点。
   * `auto` 时按「负载最低 + 剩余容量最多」排序取前 2 个做冗余；
   * 指定区域时只用该区域的节点，若该区域无可用节点则回退到其它区域（并记日志），
   * 避免玩家因为某个区域没部署节点而完全无法联机。
   */
  scheduleRelays(zone: string, max = 2): string[] {
    const all = this.nodes.listSchedulable();
    if (all.length === 0) return [];
    const score = (n: NodeRow): number => {
      const headroom = Math.max(0, n.capacity_peers - n.peers) / Math.max(1, n.capacity_peers);
      const loadPenalty = n.status === 'degraded' ? 0.5 : 0;
      return n.weight * headroom - loadPenalty * 100;
    };
    const sorter = (a: NodeRow, b: NodeRow) => score(b) - score(a) || a.peers - b.peers;

    if (zone === 'auto') {
      return all.sort(sorter).slice(0, max).map((n) => n.id);
    }
    const inZone = all.filter((n) => n.region === zone);
    if (inZone.length === 0) {
      log.warn('指定区域没有可用节点，回退到全局调度', { zone });
      return all.sort(sorter).slice(0, max).map((n) => n.id);
    }
    return inZone.sort(sorter).slice(0, Math.min(max, inZone.length)).map((n) => n.id);
  }

  /* ------------------------------------------------------------ 内部 */

  #uniqueCode(): string {
    for (let i = 0; i < 32; i += 1) {
      const code = generateRoomCode(randomBytesBuf);
      if (!this.rooms.findByCode(code)) return code;
    }
    throw HttpError.internal('无法生成唯一的房间加入码');
  }

  bumpAcl(roomId: string): number {
    return this.rooms.bumpAclRevision(roomId);
  }
}

/**
 * 房主设置的房间准入密码。
 * 注意这跟账号密码不同：它只是「进房间的暗号」，真正的隔离靠 32 位随机的
 * network_secret。所以用固定盐 + sha256 即可，无需 scrypt 的抗暴力成本。
 */
export function hashRoomPassword(password: string): string {
  return `sha256$${createHash('sha256').update(`mclink-room-v1:${password}`).digest('base64url')}`;
}

export function verifyRoomPassword(password: string, stored: string | null): boolean {
  if (!stored) return true;
  return hashRoomPassword(password) === stored;
}
