/**
 * 客户端主状态机。
 *
 * 一个玩家的完整生命周期都收敛在这里：
 *   登录 → 选区域/建房或进房 → 拿到票据 → 拉起本地 easytier-core
 *   → 周期心跳（上报虚拟 IP / peer / 流量）→ 房主按需热应用 ACL
 *   → 被踢或被关闭时自动断开
 *
 * UI 只读这里的状态、调这里的方法，不直接碰 easytier 与 HTTP。
 */
import { computed, reactive, ref } from 'vue';
import {
  Routes,
  Topics,
  type PlatformSettings,
  type Room,
  type RoomMember,
  type RoomTicket,
  type UserSelf,
  type RegionDef,
} from '@mclink/shared';
import { REGIONS } from '@mclink/shared';
import { api, friendlyError, getDeviceName, getMasterUrl, getToken, setDeviceName, setMasterUrl, setToken } from './api.ts';
import type { CoreLogEntry, CoreStatus } from './core-types.ts';

/* ------------------------------------------------------------ 工具函数 */

/** easytier-cli 的 JSON 输出把数值格式化成 "17.33 kB" / "-" 这样的字符串 */
function parseHumanNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const text = value.trim();
  if (text.length === 0 || text === '-' || text === '*') return 0;
  const m = /^([\d.]+)\s*([a-zA-Z]*)$/.exec(text);
  if (!m) return 0;
  const base = Number.parseFloat(m[1] ?? '');
  if (!Number.isFinite(base)) return 0;
  const unit = (m[2] ?? '').toLowerCase();
  const factors: Record<string, number> = {
    '': 1,
    b: 1,
    kb: 1000,
    mb: 1e6,
    gb: 1e9,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
  };
  return base * (factors[unit] ?? 1);
}

function parseLatency(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text === '-' || text === '*') return null;
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? n : null;
}

export interface PeerView {
  hostname: string;
  ipv4: string;
  cost: string;
  latencyMs: number | null;
  rxBytes: number;
  txBytes: number;
  tunnelProto: string;
}

function parsePeers(data: unknown): PeerView[] {
  if (!Array.isArray(data)) return [];
  const out: PeerView[] = [];
  for (const row of data as Array<Record<string, unknown>>) {
    const ipv4 = String(row.ipv4 ?? '');
    const cost = String(row.cost ?? '');
    if (cost === 'Local' && ipv4.length === 0) continue;
    out.push({
      hostname: String(row.hostname ?? ''),
      ipv4,
      cost,
      latencyMs: parseLatency(row.lat_ms),
      rxBytes: parseHumanNumber(row.rx_bytes),
      txBytes: parseHumanNumber(row.tx_bytes),
      tunnelProto: String(row.tunnel_proto ?? ''),
    });
  }
  return out;
}

/* --------------------------------------------------------------- 状态 */

export interface ActiveSession {
  room: Room;
  members: RoomMember[];
  ticket: RoomTicket;
  isHost: boolean;
  aclRevision: number;
  virtualIp: string;
}

const state = reactive({
  /** 是否已连上主控并登录 */
  ready: false,
  masterUrl: getMasterUrl(),
  deviceName: getDeviceName(),
  listenPort: 0,
  user: null as UserSelf | null,
  hosted: [] as Room[],
  joined: [] as Room[],
  regions: [] as Array<RegionDef & { onlineNodes: number; peers: number; capacity: number }>,
  settings: null as PlatformSettings | null,
  session: null as ActiveSession | null,
  peers: [] as PeerView[],
  coreStatus: null as CoreStatus | null,
  coreLogs: [] as CoreLogEntry[],
  busy: false,
  lastError: null as string | null,
  kickedReason: null as string | null,
  /** 房间内累计流量（本地统计，用于界面显示） */
  localRxBytes: 0,
  localTxBytes: 0,
  localRxBps: 0,
  localTxBps: 0,
});

export const clientState = state;
export const isOnline = computed(() => state.coreStatus?.state === 'running');
export const hasRoom = computed(() => state.session !== null);
export const isHost = computed(() => state.session?.isHost === true);
export const shareAddress = computed(() => state.session?.ticket.hostVirtualIp ?? null);

let heartbeatTimer: number | null = null;
let ws: WebSocket | null = null;
let wsReconnect: number | null = null;
let wsClosedByUs = false;

/* ------------------------------------------------------------ 生命周期 */

export async function bootstrap(): Promise<void> {
  try {
    const info = await window.mclink.info();
    state.coreStatus = await window.mclink.core.status();
    if (!state.deviceName) {
      state.deviceName = `${info.hostname || '玩家'}-PC`;
      setDeviceName(state.deviceName);
    }
    const free = await window.mclink.freePort();
    // 选一个不易与常见服务冲突的端口段，避免和主控自身的 11010 撞车
    state.listenPort = free > 20000 ? free : free + 20000;
    window.mclink.core.onStatus((status) => {
      state.coreStatus = status;
    });
    window.mclink.core.onLog((entry) => {
      state.coreLogs = [...state.coreLogs.slice(-500), entry];
    });
    state.coreLogs = await window.mclink.core.logs(300);
    state.ready = true;
  } catch (err) {
    state.lastError = `初始化失败：${friendlyError(err)}`;
  }

  if (getToken()) {
    try {
      await refreshUser();
      await loadRooms();
      await loadPlatformInfo();
      connectRealtime();
    } catch {
      setToken(null);
      state.user = null;
    }
  }
}

export function setMaster(url: string): void {
  setMasterUrl(url);
  state.masterUrl = getMasterUrl();
  setToken(null);
  state.user = null;
  disconnectRealtime();
}

export function setDevice(name: string): void {
  state.deviceName = name;
  setDeviceName(name);
}

export async function loadPlatformInfo(): Promise<void> {
  try {
    const [regions, meta] = await Promise.all([
      api.get<Array<RegionDef & { onlineNodes: number; peers: number; capacity: number }>>(Routes.regions),
      api.get<{ clientVersion: string; relayPort: number; registrationOpen: boolean }>(Routes.meta),
    ]);
    state.regions = regions;
    state.settings = await api.get<PlatformSettings>('/admin/settings', {})
      .then((r) => (r as unknown as { settings: PlatformSettings }).settings)
      .catch(() => null);
    void meta;
  } catch {
    state.regions = REGIONS.map((r) => ({ ...r, onlineNodes: 0, peers: 0, capacity: 0 }));
  }
}

export async function login(username: string, password: string): Promise<void> {
  const result = await api.post<{ token: string; user: UserSelf }>(Routes.login, { username, password });
  setToken(result.token);
  state.user = result.user;
  await loadRooms();
  await loadPlatformInfo();
  connectRealtime();
}

export async function register(username: string, password: string, displayName?: string): Promise<void> {
  const result = await api.post<{ token: string; user: UserSelf }>(Routes.register, {
    username,
    password,
    displayName,
  });
  setToken(result.token);
  state.user = result.user;
  await loadRooms();
  connectRealtime();
}

export async function logout(): Promise<void> {
  await stopNetwork();
  try {
    await api.post(Routes.logout);
  } catch {
    /* 忽略 */
  }
  setToken(null);
  state.user = null;
  state.session = null;
  state.hosted = [];
  state.joined = [];
  disconnectRealtime();
}

async function refreshUser(): Promise<void> {
  state.user = await api.get<UserSelf>(Routes.me);
}

export async function loadRooms(): Promise<void> {
  const data = await api.get<{ hosted: Room[]; joined: Room[] }>(Routes.rooms);
  state.hosted = data.hosted;
  state.joined = data.joined;
}

/* --------------------------------------------------------------- 房间 */

export async function createRoom(input: {
  name: string;
  zone: string;
  access: 'open' | 'password' | 'approval';
  password?: string;
  visibility?: 'public' | 'hidden';
  maxPlayers?: number;
}): Promise<Room> {
  state.busy = true;
  state.lastError = null;
  try {
    const result = await api.post<{ room: Room; ticket: RoomTicket; member: RoomMember }>(Routes.rooms, {
      name: input.name,
      zone: input.zone,
      access: input.access,
      password: input.password,
      visibility: input.visibility ?? 'public',
      maxPlayers: input.maxPlayers,
      listenPort: state.listenPort,
      deviceName: state.deviceName,
    });
    await enterRoom(result.room.id, result.ticket);
    await loadRooms();
    return result.room;
  } catch (err) {
    state.lastError = friendlyError(err);
    throw err;
  } finally {
    state.busy = false;
  }
}

export async function joinRoom(code: string, password?: string): Promise<void> {
  state.busy = true;
  state.lastError = null;
  try {
    const result = await api.post<{ room: Room; ticket: RoomTicket | null; pending: boolean }>(Routes.roomJoin, {
      code,
      password,
      deviceName: state.deviceName,
      listenPort: state.listenPort,
    });
    if (result.pending || !result.ticket) {
      state.lastError = '已提交加入申请，等待房主审批';
      await loadRooms();
      return;
    }
    await enterRoom(result.room.id, result.ticket);
    await loadRooms();
  } catch (err) {
    state.lastError = friendlyError(err);
    throw err;
  } finally {
    state.busy = false;
  }
}

/** 进入房间：拉成员列表、启动虚拟网络、开始心跳 */
export async function enterRoom(roomId: string, ticket: RoomTicket): Promise<void> {
  const detail = await api.get<{ room: Room; members: RoomMember[]; isHost: boolean }>(Routes.room(roomId));
  state.session = {
    room: detail.room,
    members: detail.members,
    ticket,
    isHost: detail.isHost,
    aclRevision: ticket.aclRevision,
    virtualIp: ticket.virtualIp,
  };
  subscribeRoom(roomId);
  await startNetwork();
  startHeartbeat();
}

export async function reenterRoom(roomId: string): Promise<void> {
  const ticket = await api.get<RoomTicket>(`${Routes.roomTicket(roomId)}?listenPort=${state.listenPort}`);
  await enterRoom(roomId, ticket);
}

export async function refreshRoom(): Promise<void> {
  const session = state.session;
  if (!session) return;
  const detail = await api.get<{ room: Room; members: RoomMember[]; isHost: boolean }>(Routes.room(session.room.id));
  session.room = detail.room;
  session.members = detail.members;
  session.isHost = detail.isHost;
}

export async function leaveRoom(): Promise<void> {
  const session = state.session;
  if (!session) return;
  const roomId = session.room.id;
  try {
    await api.post(Routes.roomLeave(roomId));
  } catch {
    /* 即使接口失败也要断开本地网络 */
  }
  await stopNetwork();
  unsubscribeRoom(roomId);
  state.session = null;
  await loadRooms();
}

export async function closeRoom(): Promise<void> {
  const session = state.session;
  if (!session) return;
  await api.post(Routes.roomClose(session.room.id));
  await stopNetwork();
  state.session = null;
  await loadRooms();
}

/* ---------------------------------------------------------- 网络控制 */

async function startNetwork(): Promise<void> {
  const session = state.session;
  if (!session) return;
  const status = await window.mclink.core.start({
    configToml: session.ticket.configToml,
    launchArgs: session.ticket.launchArgs,
    instanceName: session.ticket.instanceName,
  });
  state.coreStatus = status;
  if (status.state === 'error') {
    state.lastError = describeCoreError(status.lastError);
    return;
  }
  // 房主需要把自己实例上的 ACL 应用上去（踢人/限速）
  if (session.isHost && session.ticket.aclToml) {
    await applyHostAclIfNeeded(true);
  }
  await pollPeers();
}

async function stopNetwork(): Promise<void> {
  stopHeartbeat();
  state.peers = [];
  state.coreStatus = await window.mclink.core.stop();
}

/** 把底层报错翻译成玩家能据以行动的建议 */
function describeCoreError(message: string | null): string {
  if (!message) return '虚拟网络启动失败';
  if (/10049|AddrNotAvailable|bind/i.test(message)) {
    return '虚拟网络启动失败：网卡绑定被拒绝。请尝试「以管理员身份重启」后再连接。';
  }
  if (/Access is denied|permission|拒绝访问/i.test(message)) {
    return '虚拟网络启动失败：权限不足，创建虚拟网卡需要管理员权限。请使用「以管理员身份重启」。';
  }
  if (/wintun|TUN|adapter/i.test(message)) {
    return '虚拟网络启动失败：无法创建虚拟网卡（wintun）。请确认已安装 wintun.dll 并以管理员运行。';
  }
  return `虚拟网络启动失败：${message}`;
}

export async function pollPeers(): Promise<void> {
  const res = await window.mclink.core.peers();
  if (!res.ok) return;
  const peers = parsePeers(res.data);
  let rx = 0;
  let tx = 0;
  for (const p of peers) {
    rx += p.rxBytes;
    tx += p.txBytes;
  }
  // 用相邻两次采样的差值估算实时速率
  if (state.localRxBytes > 0 && rx >= state.localRxBytes) {
    state.localRxBps = Math.max(0, (rx - state.localRxBytes) * 8 / 5);
    state.localTxBps = Math.max(0, (tx - state.localTxBytes) * 8 / 5);
  }
  state.localRxBytes = rx;
  state.localTxBytes = tx;
  state.peers = peers;
}

/* -------------------------------------------------------------- 心跳 */

function startHeartbeat(): void {
  stopHeartbeat();
  void sendHeartbeat();
  heartbeatTimer = window.setInterval(() => void sendHeartbeat(), 10_000);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function sendHeartbeat(): Promise<void> {
  const session = state.session;
  if (!session) return;
  await pollPeers();
  try {
    const result = await api.post<{ kicked: boolean; aclToml: string | null; aclRevision: number }>(
      Routes.roomHeartbeat(session.room.id),
      {
        virtualIp: session.virtualIp,
        deviceName: state.deviceName,
        peers: state.peers.map((p) => ({
          ipv4: p.ipv4,
          cost: p.cost,
          latencyMs: p.latencyMs,
        })),
        rxBps: Math.round(state.localRxBps),
        txBps: Math.round(state.localTxBps),
        // 带上已应用的 ACL 版本，服务端只在版本变化时才回传 ACL
        aclRevision: session.aclRevision,
        coreStatus: state.coreStatus?.state ?? 'stopped',
        coreError: state.coreStatus?.lastError ?? null,
      },
    );

    if (result.kicked) {
      state.kickedReason = '你已被房主移出该房间';
      await stopNetwork();
      state.session = null;
      await loadRooms();
      return;
    }

    if (session.isHost && result.aclToml && result.aclRevision !== session.aclRevision) {
      session.aclRevision = result.aclRevision;
      await applyHostAclIfNeeded(true);
    }
  } catch (err) {
    // 网络抖动不应该让玩家掉线，只提示
    state.lastError = friendlyError(err);
  }
}

/**
 * 房主把服务端算好的 ACL 应用到本地实例。
 * 优先热更新（不中断），不支持时回退为重启核心（会短暂断线）。
 */
let applyingAcl = false;
export async function applyHostAclIfNeeded(force = false): Promise<void> {
  const session = state.session;
  if (!session?.isHost) return;
  if (applyingAcl && !force) return;
  applyingAcl = true;
  try {
    const current = await api.get<{ aclToml: string; revision: number }>(Routes.roomAcl(session.room.id));
    if (current.revision === session.aclRevision && !force) return;
    const res = await window.mclink.core.applyAcl(current.aclToml);
    session.aclRevision = current.revision;
    if (!res.ok) {
      state.lastError = `应用房间规则失败：${res.error ?? '未知原因'}`;
    } else if (res.mode === 'restart') {
      state.lastError = '房间规则已生效（当前 EasyTier 版本不支持热更新，房主实例已重启）';
    }
  } catch (err) {
    state.lastError = friendlyError(err);
  } finally {
    applyingAcl = false;
  }
}

/* -------------------------------------------------------- 房主操作 */

export async function kickMember(userId: string, reason?: string): Promise<void> {
  const session = state.session;
  if (!session) return;
  const result = await api.post<{ aclToml: string; revision: number }>(Routes.roomKick(session.room.id), {
    userId,
    reason,
  });
  session.aclRevision = result.revision;
  const res = await window.mclink.core.applyAcl(result.aclToml);
  if (res.mode === 'restart') {
    state.lastError = '已踢出成员；房间规则已通过重启实例生效';
  }
  await refreshRoom();
}

export async function approveMember(userId: string, approve: boolean): Promise<void> {
  const session = state.session;
  if (!session) return;
  await api.post(Routes.roomApprove(session.room.id), { userId, approve });
  await refreshRoom();
}

export async function rotateSecret(): Promise<void> {
  const session = state.session;
  if (!session) return;
  await api.post(Routes.roomRotateSecret(session.room.id));
  // 网络身份变了，必须用新票据重连
  await stopNetwork();
  await reenterRoom(session.room.id);
  state.lastError = '房间密钥与网络名已轮换，所有成员需要用新票据重新加入';
}

export async function updateRoomPolicy(patch: Record<string, unknown>): Promise<void> {
  const session = state.session;
  if (!session) return;
  const result = await api.patch<{ room: Room; aclToml: string; revision: number }>(Routes.room(session.room.id), patch);
  session.room = result.room;
  session.aclRevision = result.revision;
  if (session.isHost) {
    const res = await window.mclink.core.applyAcl(result.aclToml);
    if (res.mode === 'restart') {
      state.lastError = '房间策略已更新，规则通过重启实例生效';
    }
  }
}

/* ------------------------------------------------------- WebSocket */

function connectRealtime(): void {
  disconnectRealtime();
  wsClosedByUs = false;
  const token = getToken();
  if (!token) return;
  const url = `${getMasterUrl().replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`;
  try {
    ws = new WebSocket(url);
  } catch {
    return;
  }
  ws.addEventListener('open', () => {
    ws?.send(JSON.stringify({ type: 'subscribe', topics: [Topics.platform] }));
    if (state.session) subscribeRoom(state.session.room.id);
  });
  ws.addEventListener('message', (event) => {
    void handleServerEvent(String((event as MessageEvent).data));
  });
  ws.addEventListener('close', () => {
    ws = null;
    if (wsClosedByUs) return;
    wsReconnect = window.setTimeout(() => connectRealtime(), 4000);
  });
}

function disconnectRealtime(): void {
  wsClosedByUs = true;
  if (wsReconnect !== null) {
    window.clearTimeout(wsReconnect);
    wsReconnect = null;
  }
  ws?.close();
  ws = null;
}

export function subscribeRoom(roomId: string): void {
  ws?.send(JSON.stringify({ type: 'subscribe', topics: [Topics.room(roomId), Topics.user(state.user?.id ?? '')] }));
}

export function unsubscribeRoom(roomId: string): void {
  ws?.send(JSON.stringify({ type: 'unsubscribe', topics: [Topics.room(roomId)] }));
}

async function handleServerEvent(raw: string): Promise<void> {
  let event: { type?: string; [k: string]: unknown };
  try {
    event = JSON.parse(raw) as { type?: string };
  } catch {
    return;
  }
  switch (event.type) {
    case 'room.kicked': {
      const roomId = String(event.roomId ?? '');
      if (state.session?.room.id === roomId) {
        state.kickedReason = String(event.reason ?? '你已被房主移出该房间');
        await stopNetwork();
        state.session = null;
      }
      break;
    }
    case 'room.acl': {
      const session = state.session;
      if (session?.isHost && String(event.roomId) === session.room.id) {
        session.aclRevision = Number(event.revision ?? 0);
        await applyHostAclIfNeeded(true);
      }
      break;
    }
    case 'room.update':
    case 'room.members': {
      if (state.session && String(event.roomId) === state.session.room.id) {
        await refreshRoom().catch(() => {});
      }
      break;
    }
    case 'room.joinRequest': {
      await refreshRoom().catch(() => {});
      break;
    }
    default:
      break;
  }
}

/* ---------------------------------------------------------- 其它动作 */

export async function openLogsFolder(): Promise<void> {
  const info = await window.mclink.info();
  await window.mclink.openPath(info.logDir);
}

export async function relaunchElevated(): Promise<void> {
  const res = await window.mclink.relaunchElevated();
  if (!res.ok) state.lastError = res.error ?? '提权失败';
}

export function clearError(): void {
  state.lastError = null;
}

export function clearKicked(): void {
  state.kickedReason = null;
}
