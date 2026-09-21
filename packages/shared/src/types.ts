/**
 * mclink 领域模型 —— 服务端、网页端、Windows 客户端共用同一份契约。
 * 所有时间字段统一为 ISO-8601 UTC 字符串，避免时区歧义。
 */

export type Iso = string;

/* ------------------------------------------------------------------ 用户 */

export type UserRole = 'admin' | 'user';

/** 对外可见的用户信息（不含任何敏感字段） */
export interface User {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  banned: boolean;
  createdAt: Iso;
}

/** 仅本人可见的账号信息 */
export interface UserSelf extends User {
  email: string | null;
  /** 邮箱是否已验证。开启「要求验证邮箱」后，未验证账号不能建房/进房 */
  emailVerified: boolean;
  /** 月度流量配额（字节）；null = 不限 */
  quotaBytes: number | null;
  /** 本计费周期已用流量（字节） */
  usedBytes: number;
  /** 账号下最多可创建的房间数；null = 用平台默认 */
  maxRooms: number | null;
}

/* ------------------------------------------------------------ 子节点/中继 */

export type NodeStatus = 'pending' | 'online' | 'degraded' | 'offline' | 'disabled';

/**
 * 子节点 = 部署在各区域的 EasyTier 公共中继。
 * 它不属于任何房间，只靠 relay_network_whitelist 为外来网络转发，
 * 因此一个监听端口即可服务所有房间。
 */
export interface RelayNode {
  id: string;
  name: string;
  region: string;
  /** 客户端连接用的公网地址，形如 `relay-sh.example.com:11010` */
  endpoint: string;
  /** 节点上报的公网 IP，仅管理员可见 */
  publicIp: string | null;
  status: NodeStatus;
  version: string | null;
  /** 容量：可承载的最大并发 peer 数 */
  capacityPeers: number;
  /** 实时：当前承载的 peer 数 / 房间数 */
  peers: number;
  rooms: number;
  /** 实时速率（bit/s） */
  rxBps: number;
  txBps: number;
  /** 调度权重，越大越优先；0 表示不再分配新房间 */
  weight: number;
  tags: string[];
  /** 最近一次心跳 */
  lastSeenAt: Iso | null;
  createdAt: Iso;
}

/* ------------------------------------------------------------------ 房间 */

export type RoomStatus = 'open' | 'closed' | 'expired';
/** open = 凭加入码直接进；password = 需要房间密码；approval = 房主审批 */
export type RoomAccess = 'open' | 'password' | 'approval';
/** public = 出现在大厅列表；hidden = 仅凭加入码可见 */
export type RoomVisibility = 'public' | 'hidden';

export type MemberRole = 'host' | 'member';
export type MemberStatus = 'pending' | 'active' | 'kicked' | 'left';

export interface RoomPolicy {
  maxPlayers: number;
  /**
   * 房间总带宽上限（kbps）；0 = 不限。
   * 落地方式：房主实例的 `instance_recv_bps_limit`。因为所有客户端→房主的流量
   * 都汇到房主这一个实例上，它能有效约束房间的「上行入口」总量。
   * 换算见 `kbpsToBytesPerSecond()`——EasyTier 的 `_bps_limit` 单位是**字节/秒**，
   * 不是比特/秒，直接乘 1000 会让实际带宽变成配置值的 8 倍。
   */
  maxBandwidthKbps: number;
  /**
   * 单成员带宽上限（kbps）；0 = 不限。
   * 落地方式：成员本地实例的 `instance_recv_bps_limit`（限制该成员下载）。
   * 注意这是客户端自制的限速，恶意客户端可以绕过；服务端侧的硬限制只有
   * 平台级的中继出口限速。
   */
  perMemberKbps: number;
  /**
   * 房间游戏端口的包速率上限（包/秒）；0 = 不限。
   * 落地方式：房主实例 ACL 规则的 `rate_limit`。
   * EasyTier 的 ACL 限速单位是包/秒而不是比特率，界面上不要写成带宽。
   */
  rateLimitPps: number;
  /** 是否允许成员之间直连（P2P）；关闭后所有流量走中继，可控但更耗带宽 */
  allowP2p: boolean;
  /** 是否允许子节点之外的第三方中继 */
  allowPublicRelay: boolean;
  /** 游戏端口白名单，如 ["25565"]；留空表示不限制 */
  allowedPorts: string[];
  /**
   * 严格端口模式：ACL 默认动作改为丢弃，只放行 allowedPorts 与 ICMP。
   * 关闭时默认放行，只额外做踢人与限速，避免误伤玩法。
   */
  strictPorts: boolean;
  /** 房间公告 */
  motd: string | null;
}

export const DEFAULT_ROOM_POLICY: RoomPolicy = {
  maxPlayers: 8,
  maxBandwidthKbps: 0,
  perMemberKbps: 0,
  rateLimitPps: 0,
  allowP2p: true,
  allowPublicRelay: false,
  allowedPorts: [],
  strictPorts: false,
  motd: null,
};

export interface Room {
  /** 内部房间 ID；已与网络名解耦，知道它推不出网络名 */
  id: string;
  /** 6 位大写加入码，例如 `K7QM2P`。加入码只走主控 API，不参与 EasyTier 网络身份 */
  code: string;
  name: string;
  hostUserId: string;
  hostDisplayName: string;
  status: RoomStatus;
  access: RoomAccess;
  visibility: RoomVisibility;
  /** 玩家选择的目标区域；`auto` 表示由主控按延迟/负载推荐 */
  zone: string;
  /** 实际参与中继的节点列表（主控调度结果） */
  relayNodeIds: string[];
  policy: RoomPolicy;
  /**
   * EasyTier 网络名。
   *
   * **这是准入凭证**（共享中继按网络名决定是否中继），因此只在两个地方出现：
   *   1. 房主/成员通过票据接口拿到（`RoomTicket.networkName`）；
   *   2. 管理员查看房间详情时。
   * 面向玩家的房间列表与房间详情**必须**把它剥掉，否则等于把房间钥匙贴在大厅里。
   */
  networkName?: string;
  /** 虚拟网段，形如 10.200.7.0/24 */
  subnet: string;
  /** 当前在线成员数（含房主） */
  onlineMembers: number;
  memberCount: number;
  createdAt: Iso;
  /** 到期自动关闭；null = 不自动关闭 */
  expiresAt: Iso | null;
  closedAt: Iso | null;
  /** 懒分配的虚拟网段槽位（0-255） */
  subnetSlot: number;
}

export interface RoomMember {
  roomId: string;
  userId: string;
  username: string;
  displayName: string;
  role: MemberRole;
  status: MemberStatus;
  /** 该成员在房间虚拟网络中的地址，形如 10.200.7.3 */
  virtualIp: string | null;
  /** 成员客户端上报的设备名，便于房主识别 */
  deviceName: string | null;
  /** 成员上报的直连延迟（ms），null 表示需经中继 */
  latencyMs: number | null;
  /** 是否已 P2P 直连 */
  p2p: boolean;
  rxBps: number;
  txBps: number;
  joinedAt: Iso;
  lastSeenAt: Iso | null;
}

/* --------------------------------------------------------- 客户端启动票据 */

/** 中继连接信息（客户端用它填充 EasyTier 的 peers 列表） */
export interface RelayEndpoint {
  nodeId: string;
  region: string;
  label: string;
  /** 形如 `tcp://relay-sh.example.com:11010` */
  url: string;
  /** 形如 `udp://relay-sh.example.com:11010` */
  udpUrl: string;
  latencyMs: number | null;
}

/**
 * 客户端拿到票据后即可拉起本地 easytier-core 加入虚拟网络。
 * 票据是短时效凭证，成员退出/被踢后立即失效。
 */
export interface RoomTicket {
  roomId: string;
  roomCode: string;
  roomName: string;
  networkName: string;
  networkSecret: string;
  /** 本机在虚拟网络中的地址，带前缀，如 10.200.7.3/24 */
  virtualIp: string;
  /** 房主的虚拟地址，玩家在 MC 里填这个进服 */
  hostVirtualIp: string;
  instanceName: string;
  mtu: number;
  relays: RelayEndpoint[];
  /** 服务端生成的 EasyTier 配置（TOML），客户端可直接落盘使用 */
  configToml: string;
  /**
   * 启动 easytier-core 的完整参数列表，`%CONFIG%` 需由客户端替换为
   * 自己落盘的配置文件绝对路径。
   *
   * 为什么连命令行参数一起下发：`rpc_portal` 等选项**不在** TOML 配置里，
   * 只能通过命令行传入；由服务端统一计算可以保证同一台机器上的多个实例
   * 不会因为默认端口 15888 而互相抢占。
   */
  launchArgs: string[];
  /**
   * 房主专用：需要在本地实例上热应用的 ACL（踢人/限速）。
   * 成员票据为 null。
   */
  aclToml: string | null;
  /** ACL 版本号，变化时房主客户端需重新 acl set */
  aclRevision: number;
  issuedAt: Iso;
  expiresAt: Iso;
}

/* ------------------------------------------------------------ 流量统计 */

export type TrafficScope = 'relay' | 'room' | 'node';

export interface TrafficPoint {
  ts: Iso;
  rxBps: number;
  txBps: number;
}

export interface TrafficSeries {
  scope: TrafficScope;
  scopeId: string;
  label: string;
  /** 区间内累计字节数 */
  rxBytes: number;
  txBytes: number;
  currentRxBps: number;
  currentTxBps: number;
  points: TrafficPoint[];
}

export interface TrafficReport {
  ts: Iso;
  totalRxBps: number;
  totalTxBps: number;
  /** 全平台累计字节 */
  totalRxBytes: number;
  totalTxBytes: number;
  byRoom: Array<{ roomId: string; name: string; rxBps: number; txBps: number; peers: number }>;
  byNode: Array<{ nodeId: string; name: string; rxBps: number; txBps: number; peers: number }>;
}

/* ---------------------------------------------------------------- 概览 */

export interface PlatformOverview {
  serverTime: Iso;
  version: string;
  easytierVersion: string | null;
  uptimeSeconds: number;
  nodes: { total: number; online: number; degraded: number; offline: number; pending: number };
  rooms: { open: number; total: number; onlinePlayers: number };
  users: { total: number; online: number };
  traffic: { rxBps: number; txBps: number; rxBytesToday: number; txBytesToday: number };
  relay: RelayRuntime | null;
}

/** 主控自身 EasyTier 中继实例的实时状态 */
export interface RelayRuntime {
  running: boolean;
  /** 单端口监听地址，如 0.0.0.0:11010 */
  listen: string;
  networkName: string;
  /** 主控实例自己的 peer id */
  peerId: string | null;
  /** 直连到主控中继的 peer 数 */
  peerCount: number;
  /** 正在经由主控中继的外来网络（房间）列表 */
  foreignNetworks: ForeignNetworkInfo[];
  rxBytes: number;
  txBytes: number;
  startedAt: Iso | null;
  lastError: string | null;
}

export interface ForeignNetworkInfo {
  networkName: string;
  /** 房间 ID（若能映射到已知房间） */
  roomId: string | null;
  peerCount: number;
  rxBytes: number;
  txBytes: number;
  /** 实时速率（bit/s），由相邻两次采样差分得到 */
  rxBps: number;
  txBps: number;
  lastSeenAt: Iso | null;
}

/* ------------------------------------------------------------ 房间聊天 */

export type ChatMessageKind = 'text' | 'system';

export interface ChatMessage {
  id: number;
  roomId: string;
  /** 系统消息的 userId 为 null（例如「XX 加入了房间」） */
  userId: string | null;
  displayName: string;
  /** 房主/管理员发的消息带标记，便于界面区分 */
  role: 'host' | 'member' | 'system';
  kind: ChatMessageKind;
  body: string;
  createdAt: Iso;
}

/* ------------------------------------------------------------ 审计与设置 */

export interface AuditEntry {
  id: number;
  ts: Iso;
  actorType: 'user' | 'admin' | 'node' | 'system';
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
}

export interface PlatformSettings {
  /** 落地页标题 */
  siteName: string;
  siteTagline: string;
  /** 客户端下载地址（外链或本站静态文件） */
  clientDownloadUrl: string;
  clientVersion: string;
  clientSha256: string | null;
  /** 新用户默认月度流量配额（字节），null = 不限 */
  defaultQuotaBytes: number | null;
  defaultMaxRooms: number;
  /** 每房间默认最大人数 */
  defaultMaxPlayers: number;
  /** 房间默认存活时长（分钟），0 = 不自动过期 */
  roomTtlMinutes: number;
  /** 单节点可承载的最大 peer 数 */
  defaultCapacityPeers: number;
  /** 平台级总出口限速（kbps），0 = 不限；写入中继的 foreign_relay_bps_limit */
  relayBandwidthKbps: number;
  /** 是否允许玩家注册（关闭则仅管理员建号） */
  registrationOpen: boolean;
  /** 主控中继的公共端口 */
  relayPort: number;
  /** 公告 */
  announcement: string | null;

  /* -------------------------------------------------------------- 邮件 */

  /**
   * 是否要求先验证邮箱才能建房/进房。
   * 打开后：注册必须填邮箱；未验证邮箱的账号（含历史账号）会被服务端拒绝建房/进房。
   */
  requireEmailVerification: boolean;
  /** SMTP 服务器地址；留空表示未配置邮件服务 */
  smtpHost: string;
  smtpPort: number;
  /** 加密方式：ssl = 465 直连 TLS；starttls = 587 明文起手再升级；none = 不加密（仅限本机中继） */
  smtpSecure: SmtpEncryption;
  /** SMTP 登录账号；留空表示不做 AUTH（内网中继常见） */
  smtpUser: string;
  /**
   * SMTP 登录密码。
   * ⚠️ 只写不读：管理接口返回设置时会把它抹掉，只回 `smtpPasswordSet` 表示"已设置"。
   */
  smtpPassword: string | null;
  /** 发件人，可写 `mclink <no-reply@example.com>`；留空则用 smtpUser */
  smtpFrom: string;
  /** 验证码有效期（分钟） */
  emailCodeTtlMinutes: number;
}

/**
 * 对外返回的平台设置：所有敏感字段被抹掉，只留"是否已设置"。
 * 管理接口必须返回这个形状，而不是直接抛 PlatformSettings。
 */
export interface PublicPlatformSettings extends Omit<PlatformSettings, 'smtpPassword'> {
  smtpPasswordSet: boolean;
}

/** SMTP 连接加密方式 */
export type SmtpEncryption = 'ssl' | 'starttls' | 'none';
