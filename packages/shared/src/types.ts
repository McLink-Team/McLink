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
  /**
   * 是否已退订公告邮件。
   * 退订由邮件里的链接触发（免登录），客户端只做展示与重新开启。
   */
  emailOptOut?: boolean;
  /** 账号下最多可创建的房间数；null = 用平台默认 */
  maxRooms: number | null;
}

/**
 * 群发公告的收件人筛选。
 *
 * 角色与活跃度可以叠加，但**手填用户名优先**：一旦填了名单，就只发给名单上的人，
 * 另外两个条件被忽略 —— 手填的语义是"我就要发给这几个人"，
 * 再叠一层活跃度只会让人猜不透为什么少了人。
 */
export interface BroadcastAudience {
  /** 角色范围：全部 / 仅管理员 / 仅普通用户 */
  roles: 'all' | 'admin' | 'user';
  /** 只看最近 N 天活跃过（登录或客户端心跳）的账号；null = 不限 */
  activeWithinDays: number | null;
  /** 手工指定的用户名（非空时以它为准） */
  usernames: string[];
}

/** 筛选默认值：全部人、不限活跃度、不手填 */
export const DEFAULT_BROADCAST_AUDIENCE: BroadcastAudience = {
  roles: 'all',
  activeWithinDays: null,
  usernames: [],
};

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
  /** 客户端连接用的公网地址，形如 `relay-sh.example.com:21010`（端口 = connectPort） */
  endpoint: string;
  /**
   * 运行端口：节点上 easytier-core 实际监听的端口。
   * 由主控下发的安装命令指定；在 NAT / 端口映射后面时与链接端口不同。
   */
  listenPort: number | null;
  /**
   * 链接端口：主控下发给客户端、用来连这个节点的端口。
   * 与运行端口的区别见 `docs/deployment.md` 的「子节点端口」。
   */
  connectPort: number | null;
  /** 节点上报的公网 IP，仅管理员可见 */
  publicIp: string | null;
  status: NodeStatus;
  version: string | null;
  /** 容量：可承载的最大并发 peer 数 */
  capacityPeers: number;
  /**
   * 带宽上限（bit/s），0 = 不限。管理员按云厂商给的口径填（例如「5 Mbps BGP」= 5000000）。
   *
   * 为什么需要它：只看 peer 数是错的 —— 200 个 peer 的节点、和只有 5 个 peer
   * 却已经跑满 5Mbps 的节点，后者才是真顶不住的那台。
   */
  capacityBps: number;
  /**
   * 「只协助打洞」：这台节点不转发房间数据，只作为双方都能连上的公共 peer 协调 P2P 打洞。
   *
   * 生成节点配置时会写 `disable_relay_data = true`（EasyTier 广播 avoid-relay，
   * OSPF 给它的中继链路极大代价）。房间调度会把这类节点放在**槽 1（打洞节点）**，
   * 槽 2 才是真正承载数据的中继节点。
   */
  assistOnly?: boolean;
  /**
   * 实时：带宽利用率的 EWMA（0–1，时间常数 3 分钟）。
   * 只有主控进程里算得出来（需要相邻两次心跳差分），所以是运行时字段而非库里的列。
   */
  utilization?: number;
  /** 实时：用于算利用率的「已用带宽」（bit/s，取收发的较大者，见 services/nodes.ts） */
  usedBps?: number;
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
  /**
   * 局域网广播直通（EasyTier 的 `enable_udp_broadcast_relay`）。
   *
   * 开启后，Minecraft「多人游戏」列表里能直接看到房间，玩家不用手抄 IP。
   * 但代价很实在：Windows 上它依靠 **WinDivert 内核网络过滤驱动**去抓物理网卡的 UDP 广播，
   * 也就是每台开了这个开关的机器都会被装上一个**系统级网络驱动**。
   * 实测这会与其它软件的网络栈冲突——有玩家反馈连上虚拟网络后网易云音乐等软件上不了网
   * （`sc qc windivert` 里的驱动路径直接指向我们 vendored 的 EasyTier 目录，证据确凿）。
   *
   * 所以默认**关闭**（EasyTier 官方默认同样是关的）。想要"局域网列表里直接看到房间"的
   * 房主可以自己打开；手动「直接连接 + 虚拟 IP」在任何情况下都能用。
   */
  allowBroadcast: boolean;
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
  allowBroadcast: false,
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

/**
 * 流量账本的维度：
 *   relay    —— 主控中继自身（含它替房间转发的部分）
 *   node     —— 单个子节点（agent 心跳上报）
 *   platform —— **全网聚合**（主控 + 所有在线子节点），平台维度的读数与曲线用它
 *   room     —— 按房间归因（中继侧的 foreign network 统计）
 */
export type TrafficScope = 'platform' | 'relay' | 'room' | 'node';

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
  /**
   * 平台流量。转发全部由子节点承担，所以 rxBps/txBps 就是 nodesRxBps/nodesTxBps。
   *
   * master* 恒为 0：2026-09-28 起主控不再自带中继实例（「主控中继」这个概念已取消），
   * 字段留着只为老前端不白屏 —— 它们的语义没有变，只是永远没有来源了。
   */
  traffic: {
    rxBps: number;
    txBps: number;
    rxBytesToday: number;
    txBytesToday: number;
    masterRxBps: number;
    masterTxBps: number;
    nodesRxBps: number;
    nodesTxBps: number;
    onlineRelayNodes: number;
  };
}

/**
 * 主控自带 EasyTier 中继实例的实时状态。
 *
 * 该实例已于 2026-09-28 取消（票据里的中继只来自 `relay_nodes` 的调度结果），
 * 类型保留是因为 `RelayManager` 还在（只剩 easytier-cli 版本探测这一件职责）。
 */
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
  /**
   * 「大带宽档」的门槛（字节/秒）。
   *
   * 节点的 `capacity_bps`（控制台里那个「带宽上限 Mbps」）≥ 它就当成大管子；
   * **没填（0 = 不限）也算大管子** —— 界面上 0 的语义本来就是"不构成约束"。
   *
   * 用途有两条，都只影响**新票据**（后来进房的人），在房的人不变：
   *   1. 房间的第二台中继（兜底）优先从大带宽档里选，让每个房间一开局就握着一条大管子；
   *   2. 房间中继流量持续过大时，把大带宽节点提到主中继位置（见 `relayScaleMbps`）。
   */
  relayBigPipeBps: number;
  /**
   * 房间中继「过载」的判据（Mbps，rx+tx 之和）。
   *
   * 连续 6 个 30 秒窗口（≈3 分钟）超过它，就把该房间的大带宽中继提到主中继位置，
   * 让后来进房的人走大管子；同一房间 10 分钟内最多调一次（避免来回抖）。
   * 0 = 关闭自动提升（兜底仍会挑大带宽节点）。
   */
  relayScaleMbps: number;
  /**
   * **小带宽节点**的带宽卸荷线（百分比，默认 80）。
   *
   * 大带宽节点跑到 90% 才不再接新房间；小管子（声明了带宽上限且不到「大带宽档门槛」的节点）
   * 在这个百分比就停止**新增中继** —— 它们到 90% 时其实早就贴着天花板了，
   * 再来一个房间会把已经在玩的房间一起拖慢。
   *
   * 注意它**只挡新房间**：已经在上面跑的房间一个都不动，节点默认仍然正常中继。
   * 取值会被封顶在 90%（不会比全局线更晚卸荷）；`capacity_bps = 0`（不限）的节点不受影响。
   */
  relaySmallShedPercent: number;
  /** 是否允许玩家注册（关闭则仅管理员建号） */
  registrationOpen: boolean;
  /** 中继的默认端口：子节点注册/建房不指定端口时用的就是它 */
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
