/** 房间与成员仓储 */
import type { MemberRole, MemberStatus, Room, RoomAccess, RoomMember, RoomPolicy, RoomStatus, RoomVisibility } from '@mclink/shared';
import { DEFAULT_ROOM_POLICY } from '@mclink/shared';
import { Db, nowIso, parseJson, toBool, boolToInt, placeholders } from './index.ts';

export interface RoomRow {
  id: string;
  code: string;
  name: string;
  host_user_id: string;
  status: string;
  access: string;
  visibility: string;
  zone: string;
  relay_node_ids: string;
  policy: string;
  network_name: string;
  network_secret: string;
  subnet: string;
  subnet_slot: number;
  password_hash: string | null;
  online_members: number;
  member_count: number;
  acl_revision: number;
  created_at: string;
  expires_at: string | null;
  closed_at: string | null;
  last_active_at: string;
  /** V14：房间自己的存活时长（分钟）；null = 不自动过期 */
  ttl_minutes?: number | null;
  /**
   * V27：建房那一刻房主机器上报的节点延迟（JSON 数组 `[{nodeId, ms}]`）。
   *
   * 换台（`promoteOverloadedRooms`）拿它喂给**同一个** `selectRelays`，
   * 于是"换台目标"和"建房选中继"是同一套规则（延迟优先、差 ≤10ms 优先大管子）。
   * 老房间是 NULL → 退回"同区域 → 国内 → 香港 → 海外"的分档兜底。
   */
  relay_latency_hints?: string | null;
}

export interface MemberRow {
  room_id: string;
  user_id: string;
  role: string;
  status: string;
  virtual_ip: string | null;
  /** 成员级中继分配（NULL = 用房间默认，见 V25 迁移） */
  relay_node_id: string | null;
  seat: number | null;
  device_name: string | null;
  latency_ms: number | null;
  p2p: number;
  rx_bps: number;
  tx_bps: number;
  joined_at: string;
  last_seen_at: string | null;
  /** join 出来的字段 */
  username?: string;
  display_name?: string;
}

export interface JoinedRoomRow extends RoomRow {
  host_display_name: string;
  host_username: string;
}

function normalizePolicy(raw: unknown): RoomPolicy {
  const parsed = parseJson<Partial<RoomPolicy>>(raw, {});
  return { ...DEFAULT_ROOM_POLICY, ...parsed };
}

export function toRoom(row: JoinedRoomRow): Room {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    hostUserId: row.host_user_id,
    hostDisplayName: row.host_display_name,
    status: row.status as RoomStatus,
    access: row.access as RoomAccess,
    visibility: row.visibility as RoomVisibility,
    zone: row.zone,
    relayNodeIds: parseJson<string[]>(row.relay_node_ids, []),
    policy: normalizePolicy(row.policy),
    networkName: row.network_name,
    subnet: row.subnet,
    onlineMembers: row.online_members,
    memberCount: row.member_count,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    closedAt: row.closed_at,
    subnetSlot: row.subnet_slot,
  };
}

/**
 * 剥掉房间的「钥匙」字段，供面向玩家/匿名的接口使用。
 *
 * 为什么必须这么做：在单端口共享中继架构下，EasyTier 的网络名就是准入凭证
 * （中继只按网络名校验，network_secret 仅在 private_mode 下校验，而 private_mode
 * 对多密钥共享中继不可用）。历史上 `room.id` 曾被写成网络名的后缀，加上
 * `/rooms/public` 匿名可读，等于把房间钥匙公开了。现在 ID 已与网络名解耦，
 * 再叠加这一层剥离，杜绝任何列表/详情接口泄露网络名。
 */
export function toPublicRoom(row: JoinedRoomRow): Room {
  const room = toRoom(row);
  delete room.networkName;
  return room;
}

/** 面向成员：保留房间信息，但只有房主能看到网络名 */
export function toRoomForUser(row: JoinedRoomRow, userId: string): Room {
  if (row.host_user_id === userId) return toRoom(row);
  return toPublicRoom(row);
}

export function toMember(row: MemberRow): RoomMember {
  return {
    roomId: row.room_id,
    userId: row.user_id,
    username: row.username ?? '',
    displayName: row.display_name ?? '',
    role: row.role as MemberRole,
    status: row.status as MemberStatus,
    virtualIp: row.virtual_ip,
    /** 成员级中继分配：NULL = 用房间默认（票据层兜底） */
    relayNodeId: row.relay_node_id,
    deviceName: row.device_name,
    latencyMs: row.latency_ms,
    p2p: toBool(row.p2p),
    rxBps: row.rx_bps,
    txBps: row.tx_bps,
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
  };
}

const ROOM_SELECT = `
  select r.*, u.display_name as host_display_name, u.username as host_username
  from rooms r join users u on u.id = r.host_user_id
`;

export class RoomRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  findById(id: string): JoinedRoomRow | undefined {
    return this.db.get<JoinedRoomRow>(`${ROOM_SELECT} where r.id = ?`, id);
  }

  findByCode(code: string): JoinedRoomRow | undefined {
    return this.db.get<JoinedRoomRow>(`${ROOM_SELECT} where r.code = ? collate nocase`, code);
  }

  findByNetworkName(networkName: string): JoinedRoomRow | undefined {
    return this.db.get<JoinedRoomRow>(`${ROOM_SELECT} where r.network_name = ?`, networkName);
  }

  usedSlots(): number[] {
    const rows = this.db.all<{ subnet_slot: number }>(
      "select subnet_slot from rooms where status != 'closed' and (expires_at is null or expires_at > ?)",
      nowIso(),
    );
    return rows.map((r) => r.subnet_slot);
  }

  create(input: {
    /** 显式传入的内部 ID；刻意与网络名解耦，避免「知道 ID 就推算出网络名」 */
    id: string;
    code: string;
    name: string;
    hostUserId: string;
    access: RoomAccess;
    visibility: RoomVisibility;
    zone: string;
    relayNodeIds: string[];
    policy: RoomPolicy;
    networkName: string;
    networkSecret: string;
    subnet: string;
    subnetSlot: number;
    passwordHash: string | null;
    expiresAt: string | null;
    /** 房间自己的存活时长（分钟）；null = 不自动过期。心跳续期按它算 */
    ttlMinutes?: number | null;
    /** 建房那一刻房主机器测到的各节点延迟（JSON 字符串，V27）；换台时复用同一套排序 */
    relayLatencyHints?: string | null;
  }): JoinedRoomRow {
    const id = input.id;
    const ts = nowIso();
    this.db.run(
      `insert into rooms (id, code, name, host_user_id, status, access, visibility, zone,
        relay_node_ids, policy, network_name, network_secret, subnet, subnet_slot, password_hash,
        online_members, member_count, acl_revision, created_at, expires_at, closed_at, last_active_at, ttl_minutes,
        relay_latency_hints)
       values (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?, null, ?, ?, ?)`,
      id,
      input.code,
      input.name,
      input.hostUserId,
      input.access,
      input.visibility,
      input.zone,
      JSON.stringify(input.relayNodeIds),
      JSON.stringify(input.policy),
      input.networkName,
      input.networkSecret,
      input.subnet,
      input.subnetSlot,
      input.passwordHash,
      ts,
      input.expiresAt,
      ts,
      input.ttlMinutes ?? null,
      input.relayLatencyHints ?? null,
    );
    const row = this.findById(id);
    if (!row) throw new Error('创建房间后无法读回记录');
    return row;
  }

  updatePolicy(id: string, policy: RoomPolicy): void {
    this.db.run('update rooms set policy = ?, last_active_at = ? where id = ?', JSON.stringify(policy), nowIso(), id);
  }

  updateSettings(
    id: string,
    fields: {
      name?: string;
      access?: RoomAccess;
      visibility?: RoomVisibility;
      zone?: string;
      passwordHash?: string | null;
      relayNodeIds?: string[];
    },
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.name !== undefined) {
      sets.push('name = ?');
      params.push(fields.name);
    }
    if (fields.access !== undefined) {
      sets.push('access = ?');
      params.push(fields.access);
    }
    if (fields.visibility !== undefined) {
      sets.push('visibility = ?');
      params.push(fields.visibility);
    }
    if (fields.zone !== undefined) {
      sets.push('zone = ?');
      params.push(fields.zone);
    }
    if (fields.passwordHash !== undefined) {
      sets.push('password_hash = ?');
      params.push(fields.passwordHash);
    }
    if (fields.relayNodeIds !== undefined) {
      sets.push('relay_node_ids = ?');
      params.push(JSON.stringify(fields.relayNodeIds));
    }
    if (sets.length === 0) return;
    sets.push('last_active_at = ?');
    params.push(nowIso(), id);
    this.db.run(`update rooms set ${sets.join(', ')} where id = ?`, ...params);
  }

  /**
   * 同时更新网络名与密钥。
   * 网络名由密钥派生，所以两者必须一起改，否则会出现「名字已换、密钥没换」
   * 这类会让旧票据仍然可用的中间状态。
   */
  updateIdentity(id: string, networkName: string, secret: string): void {
    this.db.run(
      'update rooms set network_name = ?, network_secret = ?, last_active_at = ? where id = ?',
      networkName,
      secret,
      nowIso(),
      id,
    );
  }

  /**
   * 改写房间的中继名单（含顺序）。
   *
   * 用途只有一处：`RoomService.promoteOverloadedRooms()` 在房间中继过载时把**大带宽节点**
   * 提到第一位，让后来进房/重进房的人走大管子（已在房间里的客户端不受影响 —— 它们的配置
   * 是进房那一刻拿到的，这也是用户明确接受的取舍）。
   */
  setRelayNodeIds(id: string, relayNodeIds: string[]): void {
    this.db.run(
      'update rooms set relay_node_ids = ?, last_active_at = ? where id = ?',
      JSON.stringify(relayNodeIds),
      nowIso(),
      id,
    );
  }

  bumpAclRevision(id: string): number {
    this.db.run('update rooms set acl_revision = acl_revision + 1 where id = ?', id);
    return Number(this.db.scalar<number>('select acl_revision from rooms where id = ?', id) ?? 1);
  }

  setAclRevision(id: string, revision: number): void {
    this.db.run('update rooms set acl_revision = ? where id = ?', revision, id);
  }

  close(id: string, reason: 'closed' | 'expired' = 'closed'): void {
    this.db.run(
      "update rooms set status = ?, closed_at = ?, online_members = 0 where id = ?",
      reason === 'expired' ? 'expired' : 'closed',
      nowIso(),
      id,
    );
  }

  touch(id: string): void {
    this.db.run('update rooms set last_active_at = ? where id = ?', nowIso(), id);
  }

  /**
   * 顺延过期时间（"活跃即续期"）。
   *
   * 只在**确实往后推了**才写库：房间心跳每 10 秒一次，每次都写会把写放大好几倍，
   * 所以由调用方（`nextRoomExpiry`）先算好要不要动，这里只负责落库。
   */
  setExpiry(id: string, expiresAt: string): void {
    this.db.run('update rooms set expires_at = ?, last_active_at = ? where id = ? and status = ?', expiresAt, nowIso(), id, 'open');
  }

  recalcCounts(id: string): void {
    const memberCount = Number(
      this.db.scalar<number>(
        "select count(*) as c from room_members where room_id = ? and status in ('active','pending')",
        id,
      ) ?? 0,
    );
    const online = Number(
      this.db.scalar<number>(
        `select count(*) as c from room_members
         where room_id = ? and status = 'active' and last_seen_at is not null and last_seen_at > ?`,
        id,
        new Date(Date.now() - 90_000).toISOString(),
      ) ?? 0,
    );
    this.db.run('update rooms set member_count = ?, online_members = ? where id = ?', memberCount, online, id);
  }

  /**
   * 房间累计流量：**增量**累加（不是覆盖写）。
   *
   * 以前这里是 `rx_bytes = excluded.rx_bytes`（覆盖），而传进来的却是中继侧
   * "从实例启动算起"的累计值 —— 于是中继一重启房间累计就归零，一个房间被两台节点
   * 同时转发时两边互相覆盖。现在调用方（`services/traffic-ledger.ts`）先算出增量，
   * 这里只做 `+=`：多源相加、重启不丢历史。
   *
   * `peers` 是瞬时值，取最新一次上报（同一房间多源时以最后上报的为准）。
   */
  incrementUsage(roomId: string, rxBytes: number, txBytes: number, peers: number): void {
    this.db.run(
      `insert into room_usage (room_id, rx_bytes, tx_bytes, peers, updated_at) values (?, ?, ?, ?, ?)
       on conflict(room_id) do update set
         rx_bytes = room_usage.rx_bytes + excluded.rx_bytes,
         tx_bytes = room_usage.tx_bytes + excluded.tx_bytes,
         peers = excluded.peers,
         updated_at = excluded.updated_at`,
      roomId,
      Math.round(rxBytes),
      Math.round(txBytes),
      peers,
      nowIso(),
    );
  }

  usage(roomId: string): { rxBytes: number; txBytes: number; peers: number } | undefined {
    const row = this.db.get<{ rx_bytes: number; tx_bytes: number; peers: number }>(
      'select rx_bytes, tx_bytes, peers from room_usage where room_id = ?',
      roomId,
    );
    if (!row) return undefined;
    return { rxBytes: row.rx_bytes, txBytes: row.tx_bytes, peers: row.peers };
  }

  listMine(userId: string, includeClosed = false): JoinedRoomRow[] {
    const filter = includeClosed ? '' : "and r.status != 'closed'";
    return this.db.all<JoinedRoomRow>(
      `${ROOM_SELECT} where r.host_user_id = ? ${filter} order by r.created_at desc limit 100`,
      userId,
    );
  }

  listJoined(userId: string): JoinedRoomRow[] {
    return this.db.all<JoinedRoomRow>(
      `${ROOM_SELECT}
       join room_members m on m.room_id = r.id
       where m.user_id = ? and m.status = 'active' and r.status = 'open'
       order by r.last_active_at desc limit 100`,
      userId,
    );
  }

  listPublic(filter: { zone?: string; search?: string; limit?: number; offset?: number }): {
    rows: JoinedRoomRow[];
    total: number;
  } {
    const limit = Math.min(Math.max(filter.limit ?? 40, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);
    const where: string[] = ["r.status = 'open'", "r.visibility = 'public'"];
    const params: unknown[] = [];
    if (filter.zone && filter.zone !== 'auto') {
      where.push('r.zone = ?');
      params.push(filter.zone);
    }
    if (filter.search) {
      where.push('(r.name like ? or r.code like ?)');
      const like = `%${filter.search}%`;
      params.push(like, like);
    }
    const clause = where.join(' and ');
    const rows = this.db.all<JoinedRoomRow>(
      `${ROOM_SELECT} where ${clause} order by r.online_members desc, r.created_at desc limit ? offset ?`,
      ...params,
      limit,
      offset,
    );
    const total = Number(
      this.db.scalar<number>(`select count(*) as c from rooms r where ${clause}`, ...params) ?? 0,
    );
    return { rows, total };
  }

  listAll(filter: { status?: string; search?: string; limit?: number; offset?: number }): {
    rows: JoinedRoomRow[];
    total: number;
  } {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const where: string[] = ['1 = 1'];
    const params: unknown[] = [];
    if (filter.status) {
      where.push('r.status = ?');
      params.push(filter.status);
    }
    if (filter.search) {
      where.push('(r.name like ? or r.code like ? or u.display_name like ?)');
      const like = `%${filter.search}%`;
      params.push(like, like, like);
    }
    const clause = where.join(' and ');
    const rows = this.db.all<JoinedRoomRow>(
      `${ROOM_SELECT} where ${clause} order by r.created_at desc limit ? offset ?`,
      ...params,
      limit,
      offset,
    );
    const total = Number(
      this.db.scalar<number>(
        `select count(*) as c from rooms r join users u on u.id = r.host_user_id where ${clause}`,
        ...params,
      ) ?? 0,
    );
    return { rows, total };
  }

  countOpen(): number {
    return Number(this.db.scalar<number>("select count(*) as c from rooms where status = 'open'") ?? 0);
  }

  countActiveByHost(userId: string): number {
    return Number(
      this.db.scalar<number>(
        "select count(*) as c from rooms where host_user_id = ? and status = 'open'",
        userId,
      ) ?? 0,
    );
  }

  /** 找出超过 idleSeconds 没有任何活跃迹象的房间 */
  findIdle(idleSeconds: number): JoinedRoomRow[] {
    const cutoff = new Date(Date.now() - idleSeconds * 1000).toISOString();
    return this.db.all<JoinedRoomRow>(
      `${ROOM_SELECT} where r.status = 'open' and r.online_members = 0 and r.last_active_at < ?`,
      cutoff,
    );
  }

  findExpired(): JoinedRoomRow[] {
    return this.db.all<JoinedRoomRow>(
      `${ROOM_SELECT} where r.status = 'open' and r.expires_at is not null and r.expires_at < ?`,
      nowIso(),
    );
  }

  /* ------------------------------------------------------------- 成员 */

  listMembers(roomId: string, includeInactive = false): MemberRow[] {
    const filter = includeInactive ? '' : "and m.status in ('active','pending')";
    return this.db.all<MemberRow>(
      `select m.*, u.username, u.display_name
       from room_members m join users u on u.id = m.user_id
       where m.room_id = ? ${filter}
       order by case m.role when 'host' then 0 else 1 end, m.joined_at`,
      roomId,
    );
  }

  findMember(roomId: string, userId: string): MemberRow | undefined {
    return this.db.get<MemberRow>(
      `select m.*, u.username, u.display_name
       from room_members m join users u on u.id = m.user_id
       where m.room_id = ? and m.user_id = ?`,
      roomId,
      userId,
    );
  }

  usedSeats(roomId: string): number[] {
    const rows = this.db.all<{ seat: number | null }>(
      'select seat from room_members where room_id = ? and seat is not null',
      roomId,
    );
    return rows.map((r) => r.seat).filter((s): s is number => typeof s === 'number');
  }

  addMember(input: {
    roomId: string;
    userId: string;
    role: MemberRole;
    status: MemberStatus;
    virtualIp: string | null;
    seat: number | null;
    deviceName?: string | null;
    /** 成员级中继分配（加入时由调度挑，见 docs/relay-assignment.md） */
    relayNodeId?: string | null;
  }): MemberRow {
    this.db.run(
      `insert into room_members (room_id, user_id, role, status, virtual_ip, seat, device_name,
        relay_node_id, latency_ms, p2p, rx_bps, tx_bps, joined_at, last_seen_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, null, 0, 0, 0, ?, null)
       on conflict(room_id, user_id) do update set
         role = excluded.role,
         status = excluded.status,
         virtual_ip = excluded.virtual_ip,
         seat = excluded.seat,
         device_name = coalesce(excluded.device_name, room_members.device_name),
         relay_node_id = excluded.relay_node_id,
         joined_at = excluded.joined_at,
         last_seen_at = null`,
      input.roomId,
      input.userId,
      input.role,
      input.status,
      input.virtualIp,
      input.seat,
      input.deviceName ?? null,
      input.relayNodeId ?? null,
      nowIso(),
    );
    const row = this.findMember(input.roomId, input.userId);
    if (!row) throw new Error('加入成员后无法读回记录');
    return row;
  }

  updateMemberStatus(roomId: string, userId: string, status: MemberStatus): void {
    this.db.run('update room_members set status = ? where room_id = ? and user_id = ?', status, roomId, userId);
  }

  /**
   * 改某个成员的**中继分配**（`docs/relay-assignment.md`：成员票据只下发这一台）。
   * 传 null 表示退回"用房间默认"。
   */
  setMemberRelay(roomId: string, userId: string, nodeId: string | null): void {
    this.db.run('update room_members set relay_node_id = ? where room_id = ? and user_id = ?', nodeId, roomId, userId);
  }

  /** 该房间里被分配到某台节点的成员（换槽/节点不可用时用） */
  listMembersByRelay(roomId: string, nodeId: string): MemberRow[] {
    return this.db.all<MemberRow>(
      'select * from room_members where room_id = ? and relay_node_id = ? and status = ?',
      roomId,
      nodeId,
      'active',
    );
  }

  /**
   * 清掉整个房间的成员中继分配（房间换中继时用，见 `RoomService.#applyPendingRelay`）。
   *
   * 为什么整房清：单节点模型里房间换台 = 所有人都得跟着搬，留着旧分配只会让
   * 下一个人先拿到一张指向旧节点的票据（那一瞬间连不上）；清掉之后每个人
   * 下次拉票据/重连时自动分到新那台。
   */
  clearMemberRelays(roomId: string): number {
    return Number(this.db.run('update room_members set relay_node_id = null where room_id = ?', roomId).changes);
  }

  updateMemberHeartbeat(
    roomId: string,
    userId: string,
    fields: {
      virtualIp?: string | null;
      deviceName?: string | null;
      latencyMs?: number | null;
      p2p?: boolean;
      rxBps?: number;
      txBps?: number;
    },
  ): void {
    const sets = ['last_seen_at = ?'];
    const params: unknown[] = [nowIso()];
    if (fields.virtualIp !== undefined) {
      sets.push('virtual_ip = ?');
      params.push(fields.virtualIp);
    }
    if (fields.deviceName !== undefined) {
      sets.push('device_name = ?');
      params.push(fields.deviceName);
    }
    if (fields.latencyMs !== undefined) {
      sets.push('latency_ms = ?');
      params.push(fields.latencyMs);
    }
    if (fields.p2p !== undefined) {
      sets.push('p2p = ?');
      params.push(boolToInt(fields.p2p));
    }
    if (fields.rxBps !== undefined) {
      sets.push('rx_bps = ?');
      params.push(Math.round(fields.rxBps));
    }
    if (fields.txBps !== undefined) {
      sets.push('tx_bps = ?');
      params.push(Math.round(fields.txBps));
    }
    params.push(roomId, userId);
    this.db.run(`update room_members set ${sets.join(', ')} where room_id = ? and user_id = ?`, ...params);
  }

  removeMember(roomId: string, userId: string, status: MemberStatus = 'kicked'): void {
    this.db.run('update room_members set status = ? where room_id = ? and user_id = ?', status, roomId, userId);
  }

  /** 该用户是否在其它房间中作为活跃成员 */
  listRoomsForUser(userId: string): MemberRow[] {
    return this.db.all<MemberRow>(
      `select m.*, u.username, u.display_name from room_members m
       join users u on u.id = m.user_id
       join rooms r on r.id = m.room_id
       where m.user_id = ? and m.status = 'active' and r.status = 'open'`,
      userId,
    );
  }

  onlinePlayers(): number {
    return Number(
      this.db.scalar<number>(
        `select count(*) as c from room_members m join rooms r on r.id = m.room_id
         where m.status = 'active' and r.status = 'open'
           and m.last_seen_at is not null and m.last_seen_at > ?`,
        new Date(Date.now() - 90_000).toISOString(),
      ) ?? 0,
    );
  }

  membersByIds(roomId: string, userIds: string[]): MemberRow[] {
    if (userIds.length === 0) return [];
    return this.db.all<MemberRow>(
      `select m.*, u.username, u.display_name from room_members m join users u on u.id = m.user_id
       where m.room_id = ? and m.user_id in (${placeholders(userIds.length)})`,
      roomId,
      ...userIds,
    );
  }

  logAccess(roomId: string, userId: string | null, action: string, detail: string | null, ip: string | null): void {
    this.db.run(
      'insert into room_access_log (ts, room_id, user_id, action, detail, ip) values (?, ?, ?, ?, ?, ?)',
      nowIso(),
      roomId,
      userId,
      action,
      detail,
      ip,
    );
  }

  recentAccess(roomId: string, limit = 50): Array<{ ts: string; user_id: string | null; action: string; detail: string | null; ip: string | null }> {
    return this.db.all(
      'select ts, user_id, action, detail, ip from room_access_log where room_id = ? order by ts desc limit ?',
      roomId,
      limit,
    );
  }
}
