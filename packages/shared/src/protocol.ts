/**
 * 线协议：HTTP 路由表、WebSocket 事件名、错误码。
 * 服务端与客户端都从这里取常量，避免字符串漂移。
 */

export const API_PREFIX = '/api/v1';

export const Routes = {
  /* ---------- 公开 ---------- */
  meta: '/meta',
  regions: '/regions',
  downloads: '/downloads',
  stats: '/stats',

  /* ---------- 账号 ---------- */
  register: '/auth/register',
  login: '/auth/login',
  logout: '/auth/logout',
  me: '/auth/me',
  changePassword: '/auth/password',

  /* ---------- 房间（玩家） ---------- */
  rooms: '/rooms',
  roomPublic: '/rooms/public',
  roomJoin: '/rooms/join',
  room: (id: string) => `/rooms/${id}`,
  roomTicket: (id: string) => `/rooms/${id}/ticket`,
  roomMembers: (id: string) => `/rooms/${id}/members`,
  roomKick: (id: string) => `/rooms/${id}/kick`,
  roomApprove: (id: string) => `/rooms/${id}/members/approve`,
  roomClose: (id: string) => `/rooms/${id}/close`,
  roomLeave: (id: string) => `/rooms/${id}/leave`,
  roomHeartbeat: (id: string) => `/rooms/${id}/heartbeat`,
  roomRotateSecret: (id: string) => `/rooms/${id}/rotate-secret`,
  roomAcl: (id: string) => `/rooms/${id}/acl`,

  /* ---------- 子节点 agent ---------- */
  agentRegister: '/agent/register',
  agentHeartbeat: '/agent/heartbeat',
  agentConfig: '/agent/config',

  /* ---------- 管理台 ---------- */
  adminLogin: '/admin/login',
  adminOverview: '/admin/overview',
  adminNodes: '/admin/nodes',
  adminNode: (id: string) => `/admin/nodes/${id}`,
  adminNodeEnrollKey: '/admin/nodes/enroll-key',
  adminRooms: '/admin/rooms',
  adminRoom: (id: string) => `/admin/rooms/${id}`,
  adminUsers: '/admin/users',
  adminUser: (id: string) => `/admin/users/${id}`,
  adminTraffic: '/admin/traffic',
  adminAudit: '/admin/audit',
  adminSettings: '/admin/settings',
  adminRelay: '/admin/relay',
  adminRelayAcl: '/admin/relay/acl',
  adminRelayRestart: '/admin/relay/restart',
} as const;

/* ---------------------------------------------------------- WebSocket */

export const WS_PATH = '/ws';

/** 客户端 → 服务端 */
export type ClientEvent =
  | { type: 'subscribe'; topics: string[] }
  | { type: 'unsubscribe'; topics: string[] }
  | { type: 'ping'; ts: number }
  | { type: 'room.heartbeat'; roomId: string; payload: RoomHeartbeatPayload };

export interface RoomHeartbeatPayload {
  virtualIp: string | null;
  deviceName: string | null;
  /** 客户端观察到的房间内 peer 列表（来自 easytier-cli peer） */
  peers?: Array<{ hostname: string; ipv4: string; cost: string; latencyMs: number | null; rxBytes: number; txBytes: number }>;
  rxBps?: number;
  txBps?: number;
  /** 客户端当前已应用的 ACL 版本，用于避免重复下发 ACL */
  aclRevision?: number;
  /** 本地 easytier-core 的运行状态 */
  coreStatus?: 'stopped' | 'starting' | 'running' | 'error';
  coreError?: string | null;
}

/** 服务端 → 客户端 */
export type ServerEvent =
  | { type: 'hello'; serverTime: string; version: string; topics: string[] }
  | { type: 'pong'; ts: number; serverTime: string }
  | { type: 'error'; code: string; message: string }
  /** 房间成员/在线状态变化 */
  | { type: 'room.update'; roomId: string; room: unknown }
  | { type: 'room.members'; roomId: string; members: unknown[] }
  /** 该连接所属用户被踢出房间 */
  | { type: 'room.kicked'; roomId: string; reason: string }
  /** 房主专用：ACL 已变更，需在本地热应用 */
  | { type: 'room.acl'; roomId: string; aclToml: string; revision: number }
  /** 房主专用：有新成员待审批 */
  | { type: 'room.joinRequest'; roomId: string; userId: string; displayName: string }
  /** 中继节点上下线 */
  | { type: 'node.update'; node: unknown }
  /** 平台流量心跳（管理员与房间页使用） */
  | { type: 'traffic.tick'; report: unknown }
  /* 平台公告 */
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  /** 管理台：中继运行时状态 */
  | { type: 'relay.update'; relay: unknown };

export const Topics = {
  /** 平台级统计，落地页与仪表盘 */
  platform: 'platform',
  /** 全部中继节点状态（管理员） */
  nodes: 'nodes',
  /** 全部房间（管理员） */
  rooms: 'rooms',
  /** 平台流量 */
  traffic: 'traffic',
  /** 指定房间的实时状态 */
  room: (id: string) => `room:${id}`,
  /** 指定用户的私有通知（踢出、审批等） */
  user: (id: string) => `user:${id}`,
} as const;

/* -------------------------------------------------------------- 错误码 */

export const ErrorCodes = {
  BAD_REQUEST: 'bad_request',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  RATE_LIMITED: 'rate_limited',
  ROOM_FULL: 'room_full',
  ROOM_CLOSED: 'room_closed',
  ROOM_PASSWORD: 'room_password_required',
  ROOM_PENDING: 'room_approval_pending',
  QUOTA_EXCEEDED: 'quota_exceeded',
  REGISTRATION_CLOSED: 'registration_closed',
  INTERNAL: 'internal_error',
  SERVICE_UNAVAILABLE: 'service_unavailable',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** 统一错误响应体 */
export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    /** 可选的字段级校验错误 */
    fields?: Record<string, string>;
  };
}

export interface ApiOk<T> {
  ok: true;
  data: T;
}

/* ------------------------------------------------- 子节点 agent 契约 */

export interface AgentEnrollRequest {
  /** 管理员签发的一次性注册密钥 */
  enrollKey: string;
  name: string;
  region: string;
  /** 形如 relay-sh.example.com:11010 */
  endpoint: string;
  capacityPeers?: number;
  version?: string;
  tags?: string[];
}

export interface AgentEnrollResponse {
  /** 节点信息（含 nodeId、区域、endpoint、状态等） */
  node: {
    id: string;
    name: string;
    region: string;
    endpoint: string;
    status: string;
    capacityPeers: number;
  };
  /** 长期有效的节点令牌，之后所有 agent 请求携带 */
  nodeToken: string;
  relayConfigToml: string;
  /** 启动 easytier-core 的参数，`%CONFIG%` 替换为配置文件绝对路径 */
  launchArgs: string[];
  /** 建议的心跳间隔（秒），与主控的判活超时配套 */
  heartbeatIntervalSeconds: number;
}

export interface AgentHeartbeatRequest {
  version?: string;
  publicIp?: string;
  peers: number;
  rooms: number;
  rxBps: number;
  txBps: number;
  /** 每个房间的实时流量，用于平台级流量账本 */
  roomTraffic?: Array<{
    networkName: string;
    peerCount: number;
    rxBytes: number;
    txBytes: number;
    rxBps: number;
    txBps: number;
  }>;
  /** 主控希望节点应用的最新中继配置版本 */
  appliedConfigRevision?: number;
}

export interface AgentHeartbeatResponse {
  ok: true;
  /** 需要节点热应用的新配置（ACL 变更等），null 表示无变化 */
  configToml: string | null;
  configRevision: number;
  /** 是否被禁用 */
  disabled: boolean;
}
