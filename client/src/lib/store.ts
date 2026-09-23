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
  type ChatMessage,
  type PlatformSettings,
  type Room,
  type RoomMember,
  type RoomTicket,
  type UserSelf,
  type RegionDef,
} from '@mclink/shared';
import { REGIONS } from '@mclink/shared';
import { api, friendlyError, getDeviceName, getMasterUrl, getToken, setDeviceName, setToken } from './api.ts';
import type { CoreLogEntry, CoreStatus } from './core-types.ts';
import { recordRecent } from './shortcuts.ts';
import { parsePeers, type PeerView } from './easytier-parse.ts';

export type { PeerView } from './easytier-parse.ts';
export { parsePeers } from './easytier-parse.ts';

/* ------------------------------------------------------------ 工具函数 */

/* peer list / node info 的解析都在 lib/easytier-parse.ts（纯函数，可离线校验），
 * 这里导入使用，并把 parsePeers 再导出给界面复用。 */

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
  /** 由本机探测出的 EasyTier RPC 端口（只监听 127.0.0.1），见 bootstrap() 的说明 */
  rpcPort: 0,
  user: null as UserSelf | null,
  hosted: [] as Room[],
  joined: [] as Room[],
  regions: [] as Array<RegionDef & { onlineNodes: number; peers: number; capacity: number }>,
  settings: null as PlatformSettings | null,
  /**
   * 平台公开提示（来自 /meta）。
   * 客户端靠它决定"登录后是否强制走验证邮箱界面"——所以它是远端事实，
   * 不能靠本地猜：关掉校验的平台不该被客户端拦住。
   */
  platform: {
    requireEmailVerification: false,
    emailServiceAvailable: false,
    registrationOpen: true,
  },
  /** 邮箱验证状态（来自 /auth/email） */
  email: {
    email: null as string | null,
    verified: false,
    codeExpiresAt: null as string | null,
    resendAfterSeconds: 0,
    required: false,
  },
  session: null as ActiveSession | null,
  peers: [] as PeerView[],
  /** 本机客户端版本（来自 Electron 的 app.getVersion()） */
  localVersion: '',
  /**
   * 新版本信息；null = 已是最新（或还没查到）。
   *
   * 数据全部来自主控的公开接口：`/meta` 给版本号与下载地址，`/downloads` 给体积与 sha256。
   * 客户端**不自己访问 GitHub**：玩家机器未必连得上，而主控是它本来就要连的那台。
   */
  /**
   * 建房时手选节点的落地结果（被拒的节点 + 原因 + 兜底）。
   * 只在"用户选了节点但没用上"时非空，房间页据此提示一次。
   */
  nodeNotice: null as null | {
    rejected: Array<{ id: string; reason: string }>;
    accepted: string[];
    fallback: string | null;
  },
  update: null as null | {
    latest: string;
    url: string;
    sizeBytes: number | null;
    sha256: string | null;
  },
  /**
   * 每次成功进入房间 +1。
   * 用于让房间内的面板察觉「又拿到了一张新票据」（轮换密钥、被踢后重进等），
   * 从而重新拉取只属于本次会话的数据（如聊天历史补齐）。
   */
  sessionEpoch: 0,
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
/** 新版本复查的定时器（bootstrap 里起，退出时清掉） */
let updateTimer: number | null = null;
/** 房间详情刷新定时器（心跳期内的 30 秒轮询） */
let sessionTimer: number | null = null;

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
    /**
     * RPC 端口同样由本机探测，而不是让主控按 listenPort 推算。
     *
     * 推算值落在固定的 16000–16999 段里，而 Windows 上「看着空着」的端口可能属于
     * Hyper-V / WSL / Docker 保留的端口段（`netsh int ipv4 show excludedportrange`），
     * 显式绑定会直接 WSAEACCES(10013)。被排除的端口不会参与系统动态分配，
     * 所以「listen(0) 拿到的端口」天然避开了这些段——这个信息只有本机能提供。
     */
    const freeRpc = await window.mclink.freePort();
    state.rpcPort = freeRpc === state.listenPort ? await window.mclink.freePort() : freeRpc;
    window.mclink.core.onStatus((status) => {
      state.coreStatus = status;
    });
    window.mclink.core.onLog((entry) => {
      state.coreLogs = [...state.coreLogs.slice(-500), entry];
    });
    state.coreLogs = await window.mclink.core.logs(300);
    state.localVersion = info.version;
    /**
     * 新版本发现：登不登录都要查（玩家可能在登录页就卡在一个旧版本上）。
     * 之后每 6 小时复查一次 —— 客户端常年开着不关的场景很常见。
     */
    void checkForUpdate();
    updateTimer = window.setInterval(() => void checkForUpdate(), 6 * 60 * 60 * 1000);
    state.ready = true;
  } catch (err) {
    state.lastError = `初始化失败：${friendlyError(err)}`;
  }

  if (getToken()) {
    try {
      await refreshUser();
      await loadRooms();
      await loadPlatformInfo();
      await refreshEmailStatus();
      connectRealtime();
    } catch {
      setToken(null);
      state.user = null;
    }
  }
}

export function setDevice(name: string): void {
  state.deviceName = name;
  setDeviceName(name);
}

export async function loadPlatformInfo(): Promise<void> {
  try {
    const [regions, meta] = await Promise.all([
      api.get<Array<RegionDef & { onlineNodes: number; peers: number; capacity: number }>>(Routes.regions),
      api.get<{
        clientVersion: string;
        clientDownloadUrl: string;
        relayPort: number;
        registrationOpen: boolean;
        requireEmailVerification: boolean;
        emailServiceAvailable: boolean;
      }>(Routes.meta),
    ]);
    state.regions = regions;
    state.platform = {
      requireEmailVerification: meta.requireEmailVerification === true,
      emailServiceAvailable: meta.emailServiceAvailable === true,
      registrationOpen: meta.registrationOpen !== false,
    };
    // 顺手复查一次新版本：登录前后都该能发现
    void checkForUpdate(meta);
    state.settings = await api
      .get<{ settings: PlatformSettings }>('/admin/settings', {})
      .then((r) => r.settings)
      .catch(() => null);
  } catch {
    state.regions = REGIONS.map((r) => ({ ...r, onlineNodes: 0, peers: 0, capacity: 0 }));
  }
}

/* ------------------------------------------------------------ 新版本发现 */

/**
 * 版本号比较（只认 `x.y.z` 数字段）。
 * 返回 >0 表示 a 比 b 新。`v` 前缀、`-beta` 之类后缀都不参与比较 ——
 * 我们不靠预发布版本号，简单可预测比"完整 semver 语义"更重要。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/i, '')
      .split(/[.\-+]/)
      .slice(0, 3)
      .map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

/** 下载地址可能是相对路径（主控默认给 `/downloads/xxx.exe`），补上主控前缀 */
function absoluteDownloadUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${getMasterUrl()}${url.startsWith('/') ? '' : '/'}${url}`;
}

interface MetaForUpdate {
  clientVersion?: string;
  clientDownloadUrl?: string;
}

/**
 * 检查有没有新版本。任何一步失败都静默（拿不到更新信息不该影响玩家联机）。
 *
 * 只比版本号，不比对 sha256 —— 校验值的作用是玩家下载后自己核对，
 * 客户端不该因为主控还没登记校验值就假装"没有新版本"。
 */
export async function checkForUpdate(meta?: MetaForUpdate): Promise<void> {
  try {
    if (!state.localVersion) {
      const info = await window.mclink.info();
      state.localVersion = info.version;
    }
    const m = meta ?? (await api.get<MetaForUpdate>(Routes.meta));
    const latest = (m.clientVersion ?? '').trim();
    if (!latest || compareVersions(latest, state.localVersion) <= 0) {
      state.update = null;
      return;
    }
    let sizeBytes: number | null = null;
    let sha256: string | null = null;
    let url = absoluteDownloadUrl((m.clientDownloadUrl ?? '').trim());
    if (!url || url.endsWith('/')) {
      // 设置里没填下载地址时，退回下载目录里排第一的产物
      const list = await api
        .get<{ artifacts: Array<{ filename: string; url: string; size: number; sha256: string | null }> }>(
          Routes.downloads,
        )
        .catch(() => null);
      const first = list?.artifacts?.[0];
      if (!first) return;
      url = absoluteDownloadUrl(first.url);
      sizeBytes = first.size;
      sha256 = first.sha256;
    } else {
      const list = await api
        .get<{ artifacts: Array<{ filename: string; size: number; sha256: string | null }> }>(Routes.downloads)
        .catch(() => null);
      const name = url.split('/').pop() ?? '';
      const hit = list?.artifacts?.find((a) => a.filename === name);
      sizeBytes = hit?.size ?? null;
      sha256 = hit?.sha256 ?? null;
    }
    state.update = { latest, url, sizeBytes, sha256 };
  } catch {
    /* 静默：查更新失败不是错误 */
  }
}

/** 打开新版本下载页（用系统浏览器，不在客户端里下 87MB 的文件） */
export async function openUpdatePage(): Promise<void> {
  const target = state.update?.url;
  if (!target) return;
  // 只允许打开主控域名下的地址：主控被劫持也不至于把玩家送去任意站点
  if (!target.startsWith(getMasterUrl())) {
    state.lastError = '下载地址不在主控域名下，已阻止打开。';
    return;
  }
  await window.mclink.openExternal(target);
}

/* ---------------------------------------------------------- 邮箱验证 */

/** 拉取自己的邮箱验证状态（登录后、以及每次界面需要时调用） */
export async function refreshEmailStatus(): Promise<void> {
  if (!state.user) return;
  try {
    state.email = await api.get<typeof state.email>('/auth/email');
  } catch {
    /* 拿不到就维持原状态：这只是提示信息，不该让界面报错 */
  }
}

/** 绑定邮箱并要求主控寄验证码 */
export async function startEmailVerification(email: string): Promise<void> {
  const res = await api.post<{ email: string; expiresAt: string | null }>(Routes.emailStart, { email });
  state.email = { ...state.email, email: res.email, verified: false, codeExpiresAt: res.expiresAt, resendAfterSeconds: 60 };
  if (state.user) state.user = { ...state.user, email: res.email, emailVerified: false };
}

/** 提交验证码 */
export async function submitEmailCode(code: string): Promise<void> {
  const res = await api.post<{ user: UserSelf }>(Routes.emailVerify, { code });
  state.user = res.user;
  await refreshEmailStatus();
}

/** 这个账号现在必须去验证邮箱吗（界面据此强制跳转） */
export const mustVerifyEmail = computed(
  () =>
    state.user !== null &&
    state.platform.requireEmailVerification &&
    (state.email.verified === false || state.user.emailVerified === false),
);

export async function login(username: string, password: string): Promise<void> {
  const result = await api.post<{ token: string; user: UserSelf }>(Routes.login, { username, password });
  setToken(result.token);
  state.user = result.user;
  await loadRooms();
  await loadPlatformInfo();
  await refreshEmailStatus();
  connectRealtime();
}

/** 注册。填了邮箱时主控会顺带寄验证码（返回体里带 emailSent / emailError） */
export async function register(
  username: string,
  password: string,
  displayName?: string,
  email?: string,
): Promise<{ emailSent: boolean; emailError: string | null }> {
  const result = await api.post<{
    token: string;
    user: UserSelf;
    emailSent?: boolean;
    emailError?: string | null;
  }>(Routes.register, { username, password, displayName, email });
  setToken(result.token);
  state.user = result.user;
  await loadRooms();
  await loadPlatformInfo();
  await refreshEmailStatus();
  connectRealtime();
  return { emailSent: result.emailSent === true, emailError: result.emailError ?? null };
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
  /** 用户手选的中继节点（空 = 自动调度）；区域 zone 只是默认/筛选 */
  nodeIds?: string[];
}): Promise<Room> {
  state.busy = true;
  state.lastError = null;
  try {
    const result = await api.post<{
      room: Room;
      ticket: RoomTicket;
      member: RoomMember;
      nodeSelection?: {
        requested: string[];
        accepted: string[];
        rejected: Array<{ id: string; reason: string }>;
        fallback: string | null;
      };
    }>(Routes.rooms, {
      name: input.name,
      zone: input.zone,
      nodeIds: input.nodeIds ?? [],
      access: input.access,
      password: input.password,
      visibility: input.visibility ?? 'public',
      maxPlayers: input.maxPlayers,
      listenPort: state.listenPort,
      rpcPort: state.rpcPort,
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
      rpcPort: state.rpcPort,
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
  state.sessionEpoch += 1;
  // 记一笔「最近进入」，方便下次从列表里一键重进（只存在本机）
  recordRecent({
    roomId,
    code: detail.room.code,
    name: detail.room.name,
    lastAddress: ticket.hostVirtualIp || null,
    lastSeenAt: new Date().toISOString(),
  });
  subscribeRoom(roomId);
  await startNetwork();
  startHeartbeat();
}

export async function reenterRoom(roomId: string): Promise<void> {
  const ticket = await api.get<RoomTicket>(
    `${Routes.roomTicket(roomId)}?listenPort=${state.listenPort}&rpcPort=${state.rpcPort}`,
  );
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
  /**
   * ⚠️ 这里必须把票据字段「拆成原始值」再交给 IPC。
   *
   * `state` 是 reactive 的，`session.ticket.launchArgs` 拿到的是 Vue 的响应式 Proxy；
   * Electron 的 IPC 用结构化克隆传参，而 Proxy 无法被克隆 ——
   * 直接把 Proxy 传过去会抛 `DataCloneError: ... could not be cloned.`，
   * 结果是 easytier-core 永远起不来（房间页只显示「正在建立连接…」，但没有核心进程）。
   * 这个坑是实测用 CDP 连上客户端才定位到的。
   */
  const payload = {
    configToml: String(session.ticket.configToml),
    launchArgs: session.ticket.launchArgs.map((arg) => String(arg)),
    instanceName: String(session.ticket.instanceName),
  };
  const status = await window.mclink.core.start(payload);
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
  // 端口类错误必须排在 bind 分支前面，否则会被「网卡绑定被拒绝」吃掉，
  // 玩家会照着错误的建议去点提权重启，而问题其实在端口上
  if (/端口被占用|10048|10013|EADDRINUSE/i.test(message)) {
    return '虚拟网络启动失败：本地端口被占用。请关闭其它虚拟网络软件后重试，或把客户端完全退出再打开。';
  }
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
  /**
   * 每 30 秒拉一次房间详情（成员列表 / 在线人数 / 策略）。
   *
   * 心跳只上报自己的状态；**别人的** `lastSeenAt`、在线人数要靠这个刷新。
   * 之前只在收到 WebSocket 事件时才刷 —— 而"某人心跳超时掉线"恰恰不会产生事件，
   * 于是房主看到的成员列表里，一个早就掉线的人还挂着「直连 1 ms」，
   * 而右上角在线数已经把他减掉了（用户实测截图就是这个矛盾）。
   */
  sessionTimer = window.setInterval(() => {
    if (!state.session) return;
    void refreshRoom().catch(() => {});
  }, 30_000);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (sessionTimer !== null) {
    window.clearInterval(sessionTimer);
    sessionTimer = null;
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

/**
 * 保存房间策略。
 *
 * 这里必须分岔一次，因为房间策略里的字段落在**两层**上（依据 server/src/services/rooms.ts
 * 的票据生成代码，逐条核对过）：
 *
 *   · **配置级** —— 写进启动配置 configToml 的 flags，ACL 里没有它们：
 *       `enable_udp_broadcast_relay` ← allowBroadcast
 *       `disable_p2p`                ← allowP2p
 *       `instance_recv_bps_limit`    ← perMemberKbps（房主再叠加 maxBandwidthKbps）
 *   · **ACL 级** —— 踢人、限速包速率、端口白名单、最大人数、公告：
 *       服务端重算 ACL，我们本地热更新（`acl set`）即可，核心不用重启。
 *
 * 只做 ACL 热更新的话，房主打开「局域网广播直通」会**静默不生效** ——
 * 配置没变，必须重新进房才起作用（"设了没反应"，与公告不显示是同一类 bug）。
 * 所以配置级字段改完后走既有的 reenterRoom()：重新 GET 票据（拿到新配置）→
 * enterRoom() → startNetwork()，也就是"用新配置重启核心"这条既有路径。
 */
export async function updateRoomPolicy(patch: Record<string, unknown>): Promise<void> {
  const session = state.session;
  if (!session) return;
  const roomId = session.room.id;
  const result = await api.patch<{ room: Room; aclToml: string; revision: number }>(Routes.room(roomId), patch);
  session.room = result.room;
  session.aclRevision = result.revision;

  /** 只要这次改动碰到其中任何一个，就必须换票据重启核心 */
  const CONFIG_LEVEL_FIELDS = ['allowBroadcast', 'allowP2p', 'maxBandwidthKbps', 'perMemberKbps'];
  if (CONFIG_LEVEL_FIELDS.some((key) => key in patch)) {
    // 重进会重新拉票据并重启实例；startNetwork() 内部会重新应用房主 ACL，
    // 所以这条路径不必再单独调一次 applyAcl（那会白重启一次，多等两秒）。
    await reenterRoom(roomId);
    return;
  }

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
    // 断线期间的消息只能靠 HTTP 补：通知聊天面板做一次 sinceId 增量补齐
    emitRoomChat({ type: 'resync' });
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
    case 'room.message': {
      // 只处理当前房间：订阅的是 room:<id> 话题，理论上不会串房间，仍然显式过滤
      if (!state.session || String(event.roomId) !== state.session.room.id) break;
      const message = toChatMessage(event.message);
      if (message) emitRoomChat({ type: 'message', message });
      break;
    }
    case 'room.messageDeleted': {
      if (!state.session || String(event.roomId) !== state.session.room.id) break;
      const messageId = Number(event.messageId);
      if (Number.isFinite(messageId)) emitRoomChat({ type: 'deleted', messageId });
      break;
    }
    default:
      break;
  }
}

/* -------------------------------------------------------- 房间聊天事件 */

/**
 * 聊天事件只走这一条通道：`room.message` / `room.messageDeleted` 由上面的
 * handleServerEvent 分发到这里，界面（ChatPanel）订阅后自行渲染。
 *
 * 为什么不把消息直接存进 clientState：聊天是「房间页挂载期间」才关心的高频数据，
 * 放进全局状态会让每次有人说话都触发整个外壳重渲染，也会在离开房间后残留。
 */
export type RoomChatEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'deleted'; messageId: number }
  /** WebSocket（重）连上：界面应做一次 sinceId 增量补齐 */
  | { type: 'resync' };

const chatListeners = new Set<(event: RoomChatEvent) => void>();

export function onRoomChat(listener: (event: RoomChatEvent) => void): () => void {
  chatListeners.add(listener);
  return () => {
    chatListeners.delete(listener);
  };
}

function emitRoomChat(event: RoomChatEvent): void {
  for (const listener of [...chatListeners]) {
    try {
      listener(event);
    } catch {
      /* 单个订阅者出错不应该影响其它订阅者与 WS 主循环 */
    }
  }
}

/** 把 WS 下发的未知结构收敛成 ChatMessage；缺关键字段时返回 null（宁可丢一条也不崩界面） */
function toChatMessage(value: unknown): ChatMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'number' || typeof row.body !== 'string') return null;
  const role = row.role === 'host' || row.role === 'system' ? row.role : 'member';
  return {
    id: row.id,
    roomId: String(row.roomId ?? state.session?.room.id ?? ''),
    userId: typeof row.userId === 'string' ? row.userId : null,
    displayName: typeof row.displayName === 'string' ? row.displayName : '',
    role,
    kind: row.kind === 'system' ? 'system' : 'text',
    body: row.body,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
  };
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
