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
  type RelayLatencyHint,
} from '@mclink/shared';
import { REGIONS, reconnectDelayMs } from '@mclink/shared';
import { api, friendlyError, getDeviceName, getMasterUrl, getToken, setDeviceName, setToken } from './api.ts';
import { probeKey, type ProbeTarget } from './bridge.ts';
import type { CoreLogEntry, CoreStatus } from './core-types.ts';
import { recordRecent } from './shortcuts.ts';
import { parsePeers, type PeerView } from './easytier-parse.ts';
import {
  AB_OBSERVE_MS,
  AB_REVERT_COOLDOWN_MS,
  SAMPLE_WINDOW_MS,
  TRIGGER_WINDOWS,
  PROBE_BASE_MS,
  formatLoss,
  hostLinkQuality,
  hostRoute,
  loadAutoFallback,
  loadForceRelay,
  nextProbeDelay,
  relayLooksWorse,
  saveAutoFallback,
  saveForceRelay,
  withDisableP2p,
  type RelaySource,
  type RouteSample,
} from './relay-fallback.ts';
import { isMac, platform, supportsLanBroadcast, tunName } from './platform.ts';
import { handleIncomingMessage } from './notify.ts';

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

/**
 * 中继节点（`GET /nodes` 的形状；**需登录**，所以探测只能放在登录之后）。
 *
 * `port` 是**链接端口**：客户端做 TCP 延迟探测、以及真正加入房间时连的都是它，
 * 由主控按与票据同一套规则下发（见 server/src/db/nodes.ts）。老主控可能缺这一项，
 * 那时用 `/meta` 的平台端口兜底（见 relayProbeTarget）。
 */
export interface RelayNodeOption {
  id: string;
  name: string;
  region: string;
  host: string;
  port?: number;
  peers: number;
  capacity: number;
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
    /**
     * 平台默认中继端口（来自 /meta）。
     * 建房页按「节点链接端口」做 TCP 延迟探测，只有老主控的节点列表里没有端口，
     * 那时用它兜底；`0` = 不知道，就别去猜端口了。
     */
    relayPort: 0,
  },
  /**
   * 中继节点列表 + 本机测到的延迟（**应用初始化时就探一次**，见 probeRelayNodes）。
   *
   * 为什么放在应用级而不是建房页里：以前"拉节点列表 + tcping"只在建房页挂载时跑一遍，
   * 于是两条退化路径都会让主控收不到延迟提示 —— 手速快过测速、或列表拉取失败（静默 catch）
   * —— 主控那侧就只能按"权重 × 余量"排序（延迟键失效）。缓存到这份状态后，
   * 建房页与房间页读的是同一份结果，探测也不再依赖"玩家打开过建房页"。
   */
  relayNodes: [] as RelayNodeOption[],
  /** `host:port` → 最小时延（ms）；null = 这次握手没成功（只用于展示与排序，不代表节点不可用） */
  relayLatency: {} as Record<string, number | null>,
  /**
   * 探测状态（给界面显示用）。
   *
   * ⚠️ `probing` **只用来换文案，绝不用来禁用建房按钮** ——
   * 弱网或节点不可达时会永远建不了房（探测失败不该有任何阻断力）。
   */
  relayProbe: {
    probing: false,
    /** 最近一次**成功**探测的完成时间（ISO）；null = 还没测到过 */
    lastProbedAt: null as string | null,
    /** 最近一次探测是否拿到了节点列表（失败静默，保留上一份缓存） */
    ok: false,
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
  /**
   * 「强制走中继」—— 本机把这条链路钉到中继上（票据里注入 `disable_p2p = true`）。
   *
   * 为什么放在**玩家侧**而不是房间规则里：房间规则里的「允许 P2P 直连」是全体生效的，
   * 而链路劣化通常只发生在一个人身上（他家的宽带到某个对端那一段在丢包）。
   * 为一个人关掉全房间的直连，等于让另外几个人一起绕远路。
   */
  forceRelay: false,
  /** 谁钉的：manual = 玩家自己点的（任何自动化都不许撤销）；auto = 自动回落 */
  forceRelaySource: null as RelaySource | null,
  /** 正在重启核心换配置：界面显示「切换中…」，自动回落也让位 */
  relaySwitching: false,
  /** 给房间卡显示的一行结果（切换完成 / 失败 / 自动回落的结论） */
  relayNotice: null as string | null,
  /** 自动回落开关（默认关，见 lib/relay-fallback.ts） */
  autoFallback: false,
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
  /**
   * 给登录页看的一句话（现在只有一个来源：改密码成功后本机被登出）。
   * 改密码必须本地登出（原因见 changePassword），而登出之后设置页已经卸载，
   * 提示只能落在登出后玩家看到的那一屏上；成功登录后自动清掉。
   */
  authNotice: null as string | null,
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

/**
 * 「房间页此刻是不是真的在屏幕上」—— **只读状态**，房间页挂载/卸载时写。
 *
 * 为什么要它（而不是让通知模块自己去猜）：通知的第一条规则是"正看着那个房间就别弹"，
 * 而"正看着"在渲染层等于**房间内容挂在 DOM 上**（App.vue 只在 view==='home' && hasRoom
 * 时渲染 RoomPage）。窗口聚焦还不够：聚焦着停在设置页时消息是看不到的，那必须弹。
 * 由真正知道这件事的人（RoomPage）写，别处只读 —— 所以它没有 setter 之外的出口。
 */
export const roomOnScreen = ref(false);
export function setRoomOnScreen(value: boolean): void {
  roomOnScreen.value = value === true;
}

/**
 * 房主的虚拟地址（裸地址，不带 /24）——「到房主那条链路」的**唯一匹配键**。
 *
 * 取哪个字段是读代码确认过的，不是猜的：
 *   · 首选票据的 `hostVirtualIp`。主控在 roomTicket 里就是用房主成员的 `virtual_ip`
 *     去掉掩码算出来的（server/src/services/rooms.ts），和「联机地址」是同一个值 ——
 *     玩家在游戏里填的就是它，用它匹配 peer list 才不会和玩家看到的地址对不上；
 *   · 成员列表里 `role === 'host'` 那条的 `virtualIp` 作为兜底（票据之外的第二次机会，
 *     比如以后加了房主转移）。
 *
 * 本机就是房主时它等于自己的地址 —— 调用方必须先看 `isHost`：
 * 没有"到自己的链路"这回事（见 lib/relay-fallback.ts 的 hostRoute）。
 */
export function sessionHostVirtualIp(session: ActiveSession | null): string {
  if (!session) return '';
  const fromTicket = (session.ticket.hostVirtualIp ?? '').split('/')[0] ?? '';
  if (fromTicket.length > 0) return fromTicket;
  const hostMember = session.members.find((m) => m.role === 'host');
  return (hostMember?.virtualIp ?? '').split('/')[0] ?? '';
}

export const hostVirtualIp = computed(() => sessionHostVirtualIp(state.session));

/**
 * 房间页那个开关的四种状态（**唯一判据**，别在页面里另写一套 `v-if`）：
 *   policy    —— 房主在房间规则里关掉了「允许 P2P 直连」，全房间都走中继。
 *                这时玩家侧的开关是**只读**的：他改不了，也不该以为自己能改。
 *   switching —— 正在重启核心换配置（几秒断流）。
 *   on        —— 本机已走中继（手动或自动回落）。
 *   off       —— 走 P2P 直连。
 */
export type RelayMode = 'policy' | 'switching' | 'on' | 'off';
export const relayMode = computed<RelayMode>(() => {
  if (state.session?.room.policy.allowP2p === false) return 'policy';
  if (state.relaySwitching) return 'switching';
  return state.forceRelay ? 'on' : 'off';
});

let heartbeatTimer: number | null = null;
let ws: WebSocket | null = null;
let wsReconnect: number | null = null;
let wsClosedByUs = false;
/** WS 连续重连次数：退避时长随它递增（连上就归零），避免全网客户端整齐地一起回来 */
let wsAttempts = 0;
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
    state.autoFallback = loadAutoFallback();
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
      /**
       * 中继探测放在**登录成功之后**：`GET /nodes` 是需登录的接口
       * （`server/src/api/public.ts` 里 `{ auth: true }`），未登录调只会拿到 401。
       * 这里**不 await**（后台跑、失败静默）：初始化不该被一轮 tcping 拖住，
       * 而 `loadPlatformInfo()` 已经在上一步拿到 relayPort —— 老主控缺端口时要用它兜底。
       */
      ensureRelayProbe();
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
      relayPort: Number.isInteger(meta.relayPort) ? meta.relayPort : 0,
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

/* ------------------------------------------------------------ 中继节点探测 */

/**
 * 探测目标 = 节点的 `host:port`。
 *
 * 端口缺了就用 `/meta` 的平台端口兜底（只有没升级的老主控会缺这一项），
 * 还是拿不到就返回 null —— 与其猜一个端口连出个假数字，不如让界面显示「—」。
 */
export function relayProbeTarget(node: RelayNodeOption): ProbeTarget | null {
  const port = node.port && node.port > 0 ? node.port : state.platform.relayPort;
  return port > 0 ? { host: node.host, port } : null;
}

/** 这台节点本机测到的延迟（ms）；null = 没测到（只用于展示与排序） */
export function relayLatencyOf(node: RelayNodeOption): number | null {
  const target = relayProbeTarget(node);
  return target === null ? null : (state.relayLatency[probeKey(target)] ?? null);
}

/**
 * 把缓存里的延迟整理成建房请求的 `latencyHints`。
 *
 * 主控拿它**只在已经合格的候选之间排序**（自动模式选谁、手动模式先挑哪台当兜底）：
 * 它绝不放松任何硬条件（未接入/停用/权重 0/没余量/区域不符的节点，提示也拉不进来），
 * 也不影响手动勾选的优先级。测不到（null）的节点不报 —— "没测到"不是"延迟 0"。
 *
 * 过时这件事是明摆着的：值就是测速那一刻的握手延迟，之后网络会变。
 * 这里**不做**刷新/校验，主控也不判过期 —— 它只是个排序偏好，
 * 真失效的节点由主控的状态与容量兜住，用一组稍旧的相对大小排序仍然比纯按负载更贴近体感。
 */
export function relayLatencyHints(): RelayLatencyHint[] {
  const out: RelayLatencyHint[] = [];
  for (const node of state.relayNodes) {
    const ms = relayLatencyOf(node);
    if (ms !== null && Number.isFinite(ms)) out.push({ nodeId: node.id, ms });
  }
  return out;
}

/** 正在进行的探测：并发调用共用同一个 Promise，不叠加请求（重复点「重新测速」也一样） */
let probeInFlight: Promise<void> | null = null;

/**
 * 探测一次：拉节点列表 → 对每个节点的**链接端口**做 TCP 握手（tcping）→ 写进缓存。
 *
 * 测的是 tcping 而不是 ICMP：DNS + 路由 + 端口放行 + 握手全算在内，与真正建房走的是同一条路径；
 * 每个节点连打 3 次取最快的一次，免得偶发丢包让整行显示「—」
 * （桌面见 electron/tcping.cjs，安卓见 android/web/src/mobile-bridge.ts 的原生实现）。
 *
 * 全程静默失败（拉不到列表就保留上一份缓存）：这份数据**只用于"先挑谁"**，
 * 过时或缺失都不影响节点可用性，也绝不该挡住建房。
 */
export function probeRelayNodes(): Promise<void> {
  if (probeInFlight) return probeInFlight;
  probeInFlight = (async () => {
    state.relayProbe.probing = true;
    try {
      const res = await api.get<{ nodes: RelayNodeOption[] }>(Routes.clientNodes);
      const nodes = Array.isArray(res.nodes) ? res.nodes : [];
      const targets = nodes.map(relayProbeTarget).filter((t): t is ProbeTarget => t !== null);
      const latency = targets.length > 0 ? await window.mclink.tcping(targets) : {};
      state.relayNodes = nodes;
      state.relayLatency = latency;
      state.relayProbe.ok = true;
      state.relayProbe.lastProbedAt = new Date().toISOString();
    } catch {
      /* 静默：探测失败保留上一份缓存，界面显示「—」或上次测速时间 */
      state.relayProbe.ok = false;
    } finally {
      state.relayProbe.probing = false;
    }
  })().finally(() => {
    probeInFlight = null;
  });
  return probeInFlight;
}

/**
 * 「有数据就别再测」的后台探测：应用初始化（bootstrap）与登录成功后各调一次。
 *
 * 只在**完全没有缓存**时发起：列表拉到了就一直用（见 relayLatencyHints 的"过时不影响可用性"），
 * 免得每次登录都白跑一轮 tcping；真的想重测就是建房页那颗「重新测速」（probeRelayNodes）。
 * 调用方**不要 await** —— 初始化不该被一轮 tcping 拖住，失败也静默。
 */
export function ensureRelayProbe(): void {
  if (state.relayNodes.length > 0 || probeInFlight) return;
  void probeRelayNodes();
}

/** 建房提交前最多等多久正在进行的探测（毫秒）；见 waitForRelayProbe */
export const RELAY_PROBE_WAIT_MS = 1500;

/**
 * 有界等待正在进行的那次探测。
 *
 * 为什么需要它：tcping 是异步的，而建房按钮**不禁用**（弱网下禁用会让人永远建不了房），
 * 所以"手速快过测速"是真实会发生的 —— 那一刻 `relayLatencyHints()` 是空数组，
 * 主控那侧的延迟键随即失效（退化成"权重 × 余量"排序），正是本轮要修掉的退化路径。
 * 于是"探测还在跑"时先等一小会儿（最多 `RELAY_PROBE_WAIT_MS`）再取提示。
 *
 * ⚠️ 边界（硬要求）：**探测失败/超时绝不能挡住建房** ——
 * 没有在跑的探测立刻返回 false；在跑的探测最多等这么久；等不到就照常发请求
 * （空提示照样能建房，只是主控按负载排）。这个函数**不抛异常**。
 */
export async function waitForRelayProbe(timeoutMs = RELAY_PROBE_WAIT_MS): Promise<boolean> {
  const inFlight = probeInFlight;
  if (!inFlight || !(timeoutMs > 0)) return false;
  let timer: number | undefined;
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = window.setTimeout(() => resolve(false), timeoutMs);
    });
    // 探测本身已经吞掉了所有失败；这里再兜一层，保证"等待"永远不会把错误抛给调用方
    const done = inFlight.then(
      () => true,
      () => true,
    );
    return await Promise.race([done, timeout]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
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

interface MetaArtifact {
  url: string;
  filename: string;
  size: number;
  sha256: string | null;
  /** 从文件名解析出来的版本号（主控侧 versionOf()）；老主控没有这个字段 */
  version?: string | null;
  platform?: string;
}

interface MetaForUpdate {
  clientVersion?: string;
  clientDownloadUrl?: string;
  /**
   * 按平台分好的产物（主控 side buildClientDownloads）。
   *
   * 为什么更新检查要看它：`clientVersion` / `clientDownloadUrl` 是**桌面端**那条线
   * （平台设置里的「客户端版本」，现在是 1.0.8）。安卓有自己的版本线（1.0.x），
   * 拿桌面版本去比就会出现"手机上提示有新版本 1.0.8，点开给的是 Windows 安装包"。
   */
  clientDownloads?: { android?: MetaArtifact | null } | null;
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

    /*
     * 安卓走自己的产物，不碰桌面的 clientVersion/clientDownloadUrl。
     *
     * 拿不到 android 产物时**不提示**（而不是退回桌面那套）：手机上升级只能是装新 APK，
     * 指一个 .exe 过去比不提示更糟。等主控部署了带 android 字段的版本再自然生效。
     */
    if (platform === 'android') {
      const apk = m.clientDownloads?.android ?? null;
      const latest = (apk?.version ?? '').trim();
      if (!apk || !latest || compareVersions(latest, state.localVersion) <= 0) {
        state.update = null;
        return;
      }
      const url = absoluteDownloadUrl(apk.url);
      if (!url) {
        state.update = null;
        return;
      }
      state.update = { latest, url, sizeBytes: apk.size ?? null, sha256: apk.sha256 ?? null };
      return;
    }

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

/* ---------------------------------------------------------- 账号设置 */

/**
 * 改昵称（账号显示名，服务端最多 32 字）。
 *
 * 只有服务端那一份是真身：返回的 self 直接覆盖 `state.user`，
 * 左栏头像首字母（AppRail 读 `clientState.user.displayName`）、聊天与名册
 * 全都从这一份取值 —— 各页面不再自己存一份显示名。
 *
 * 房间里还要补一次 `refreshRoom()`：成员列表里的 `display_name` 是服务端
 * `join users` 现取的，不刷新的话自己（和别人）看到的都还是旧名字。
 */
export async function updateDisplayName(displayName: string): Promise<void> {
  state.user = await api.patch<UserSelf>(Routes.profile, { displayName });
  if (state.session) await refreshRoom().catch(() => {});
}

/**
 * 改密码。
 *
 * ⚠️ 服务端 `AuthService.changePassword()` 在写库之后调用
 * `users.deleteSessionsForUser(userId)` —— 删的是这个用户的**全部**会话，
 * 本机这条也在内。也就是说：响应回来那一刻，手里的 token 已经是废的，
 * 之后任何要鉴权的请求都会 401（"密码已更新，请重新登录"不是客套话，是事实）。
 * 所以这里只能立刻本地登出（清令牌 + 回登录页），并把原因写进 `authNotice`
 * 交给登录页显示；装作还登录着的话，下一页就开始报"未授权"。
 */
export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  const res = await api.post<{ ok: true; message: string }>(Routes.changePassword, {
    oldPassword,
    newPassword,
  });
  state.authNotice =
    `${res.message}。为安全起见，主控已让这个账号的所有登录会话失效（包括这台电脑），` +
    '其它设备上的 McLink 也要用新密码重新登录。';
  try {
    await logout();
  } catch {
    /**
     * 本地善后（停核心 / 通知主控 / 清状态）万一失败，也必须把界面带回未登录：
     * 令牌此刻已经被服务端删掉了，留在设置页只会撞上一连串 401，
     * 而玩家看到的会是一句和事实不符的报错。
     */
    setToken(null);
    state.user = null;
    state.session = null;
    disconnectRealtime();
  }
}

/** 玩家看过登录页上那条提示后手动关掉它 */
export function clearAuthNotice(): void {
  state.authNotice = null;
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
  // 又登进来了：上次改密码留下的那句"请重新登录"已经完成使命
  state.authNotice = null;
  await loadRooms();
  await loadPlatformInfo();
  await refreshEmailStatus();
  connectRealtime();
  /** 中继探测要等登录之后（`/nodes` 需鉴权）；后台跑，不 await（见 ensureRelayProbe） */
  ensureRelayProbe();
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
  state.authNotice = null;
  await loadRooms();
  await loadPlatformInfo();
  await refreshEmailStatus();
  connectRealtime();
  /** 注册完就是登录态了：探测照 login() 一样在后台补一次（`/nodes` 需鉴权） */
  ensureRelayProbe();
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
  /**
   * 建房前本机测到的节点延迟（可选，见 `RelayLatencyHint`）。
   *
   * 主控用它把**已经合格的**候选排个序：自动模式决定"选谁"，手动模式决定"先挑哪台当兜底"。
   * 手选的 nodeIds 仍然优先；传空数组（或干脆不传）＝ 主控完全按负载打分，老行为不变。
   * 延迟是这一刻测的，之后会变 —— 主控不做过期判断，只当排序偏好用。
   *
   * ⚠️ 调用方（建房页）在探测还在进行时应当先 `await waitForRelayProbe()`
   * 再调 `relayLatencyHints()`，否则"手速快过测速"会让这里永远收到空数组（见那里的说明）。
   */
  latencyHints?: RelayLatencyHint[];
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
      latencyHints: input.latencyHints ?? [],
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
  /**
   * 恢复这个房间上次的「强制走中继」选择 —— 必须在 startNetwork() **之前**设置：
   * 配置是在启动那一刻注入的，晚了就只能多断一次。
   * 这也是"重启客户端后开关仍然生效"的落点：偏好存在本机 localStorage 里，
   * 重启后重新进同一个房间就恢复（换房间不继承：劣化是"我和谁之间"的事）。
   */
  state.forceRelay = loadForceRelay(roomId) !== null;
  state.forceRelaySource = loadForceRelay(roomId);
  state.relayNotice = null;
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
  startRelayGuard();
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

/**
 * 真正交给 easytier-core 的配置。
 *
 * 票据永远是**原始**的那一份，`disable_p2p` 只在启动这一刻按开关注入 ——
 * 而不是"打开时改票据、关闭时删掉那一行"。
 * 理由：删行会把房主设的 `disable_p2p = true`（房间规则里关了 P2P）一起删掉，
 * 等于玩家用一个本机开关绕过了房间规则；只做单向注入就永远不可能出现这种越权。
 */
function effectiveConfigToml(): string {
  const session = state.session;
  if (!session) return '';
  const raw = String(session.ticket.configToml);
  return state.forceRelay ? withDisableP2p(raw) : raw;
}

async function startNetwork(): Promise<CoreStatus | null> {
  const session = state.session;
  if (!session) return null;
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
    configToml: effectiveConfigToml(),
    launchArgs: session.ticket.launchArgs.map((arg) => String(arg)),
    instanceName: String(session.ticket.instanceName),
  };
  const status = await window.mclink.core.start(payload);
  state.coreStatus = status;
  if (status.state === 'error') {
    state.lastError = describeCoreError(status.lastError);
    return status;
  }
  // 房主需要把自己实例上的 ACL 应用上去（踢人/限速）
  if (session.isHost && session.ticket.aclToml) {
    await applyHostAclIfNeeded(true);
  }
  await pollPeers();
  return status;
}

async function stopNetwork(): Promise<void> {
  stopHeartbeat();
  stopRelayGuard();
  state.peers = [];
  // 开关的持久值留着（下次进同一个房间要恢复），但当前会话的运行时状态要清掉
  state.forceRelay = false;
  state.forceRelaySource = null;
  state.relayNotice = null;
  state.coreStatus = await window.mclink.core.stop();
}

/** 把底层报错翻译成玩家能据以行动的建议 */
function describeCoreError(message: string | null): string {
  if (!message) return '虚拟网络启动失败';
  /**
   * Android 直接原样返回，上面这些规则一条都不套用。
   *
   * 为什么必须提前返回：下面每一条建议都是**桌面专属**的 —— 「以管理员身份重启」「确认已安装
   * wintun.dll」「点 UAC 授权框」在手机上没有任何对应动作。而 EasyTier 在 Android 上的典型报错
   * 恰好命中这些正则（内核报的是 tun / permission / bind 那几个词），于是玩家会看到一句
   * 手机上做不到的指引，比不给建议更糟。
   *
   * Android 侧的文案由 `MclinkVpnPlugin` 按 `lastErrorCode` 生成（见 docs/android-vpn.md §3），
   * 那里才知道"没授权 VPN"和"被别的 VPN 占用"的区别。
   */
  if (platform === 'android') return message;
  // 端口类错误必须排在 bind 分支前面，否则会被「网卡绑定被拒绝」吃掉，
  // 玩家会照着错误的建议去点提权重启，而问题其实在端口上
  if (/端口被占用|10048|10013|EADDRINUSE/i.test(message)) {
    return '虚拟网络启动失败：本地端口被占用。请关闭其它虚拟网络软件后重试，或把客户端完全退出再打开。';
  }
  if (/10049|AddrNotAvailable|bind/i.test(message)) {
    return '虚拟网络启动失败：网卡绑定被拒绝。请尝试「以管理员身份重启」后再连接。';
  }
  if (/Access is denied|permission|拒绝访问|not permitted|Operation not permitted/i.test(message)) {
    return '虚拟网络启动失败：权限不足，创建虚拟网卡需要管理员权限。请使用「以管理员身份重启」。';
  }
  /**
   * 建网卡失败那一类。
   * Windows 上的关键词是 wintun/TUN adapter，macOS 上是 utun；文案里的那个名字
   * 也必须跟着平台走 —— 在 mac 上让玩家"确认已安装 wintun.dll"是没有意义的指引。
   */
  if (/wintun|utun|TUN|adapter/i.test(message)) {
    return isMac
      ? `虚拟网络启动失败：无法创建虚拟网卡（${tunName}）。请点「以管理员身份重启」后重试（utun 需要 root）。`
      : `虚拟网络启动失败：无法创建虚拟网卡（${tunName}）。请确认已安装 wintun.dll 并以管理员运行。`;
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

/* ==================================================== 强制走中继（玩家侧开关） */

/**
 * 打开 / 关闭「强制走中继」。
 *
 * 落地动作只有两步：把 `disable_p2p = true` 注入票据 TOML → 重启 easytier-core。
 * 这是仓库既有的"改配置→重启实例"路径（房间规则生效时走的就是它），
 * 代价是**几秒断流** —— 所以界面上必须有明确的进行中状态与确认弹层。
 *
 * 不做"热更新"：`disable_p2p` 属于启动期决策（打洞策略在 policy.rs 里按它分支），
 * EasyTier 没有对应的运行期接口。想少断一次就只能不改，没有第三条路。
 */
export async function setForceRelay(on: boolean, source: RelaySource): Promise<void> {
  const session = state.session;
  if (!session) return;
  if (state.relaySwitching) return;
  // 房主已经让全房间走中继时，玩家侧的开关是只读的：改了也不会发生任何事
  if (session.room.policy.allowP2p === false) return;

  const nextSource: RelaySource | null = on ? source : null;
  const alreadyOn = state.forceRelay === on && state.forceRelaySource === nextSource;
  state.forceRelay = on;
  state.forceRelaySource = nextSource;
  saveForceRelay(session.room.id, nextSource);
  // 只是把"手动"接管成"自动"（或反过来）不需要重启核心 —— 配置没变
  if (alreadyOn || state.coreStatus?.state !== 'running') return;

  state.relaySwitching = true;
  state.relayNotice = null;
  try {
    // 显式停一次：既保证旧进程真的没了，也让 coreStatus 走完整轨迹
    // stopped → starting → running（界面靠它显示"切换中"，验证脚本也断言这条轨迹）
    await window.mclink.core.stop();
    state.peers = [];
    const status = await startNetwork();
    if (status?.state === 'error') {
      state.relayNotice = `切换后核心没有起来：${state.lastError ?? '未知原因'}`;
      return;
    }
    /**
     * 结果那一行必须说清**是谁切的、为什么**：
     * 自动回落的消息以前被这里的通用文案盖住（房间页那段 `source === 'auto'` 的
     * 说法因此永远显示不出来），玩家只会看到"已切到中继"，不知道是程序自己动的。
     */
    state.relayNotice = on
      ? source === 'auto'
        ? '已自动切到中继：到房主的直连丢包持续偏高。'
        : '已切到中继：所有流量经中继转发，P2P 直连已停用。'
      : '已切回 P2P 直连：流量重新尝试打洞直连。';
  } catch (err) {
    state.relayNotice = `切换失败：${friendlyError(err)}`;
  } finally {
    state.relaySwitching = false;
  }
}

/** 玩家手动点开关（走确认弹层的是界面那一侧，这里只负责执行） */
export async function toggleForceRelay(): Promise<void> {
  if (state.forceRelay && state.forceRelaySource === 'auto') {
    // 玩家接管自动回落的成果：从此不再自动放 P2P 重试
    await setForceRelay(false, 'manual');
    return;
  }
  await setForceRelay(!state.forceRelay, 'manual');
}

/* ====================================================== 自动回落（默认关闭） */

/** 守卫的运行阶段；每个阶段的"下一步"都写在 guardTick 里 */
type GuardPhase = 'off' | 'watch' | 'ab' | 'serving' | 'probing';

const guard = {
  timer: null as number | null,
  phase: 'off' as GuardPhase,
  /** 连续超标的窗口数（只有 allOver 的窗口才累加） */
  streak: 0,
  /** 降级那一刻的 P2P 快照 —— A/B 对照的基线 */
  baseline: [] as RouteSample[],
  /** 当前阶段的到期时刻 */
  deadline: 0,
  /** A/B 判定"中继更差"后的静默期 */
  cooldownUntil: 0,
  /** 下一次 P2P 重试的等待时长（指数退避档位） */
  probeDelayMs: PROBE_BASE_MS,
};

function resetGuard(phase: GuardPhase): void {
  guard.phase = phase;
  guard.streak = 0;
  guard.baseline = [];
  guard.deadline = 0;
}

/**
 * 自动回落的主循环。每 SAMPLE_WINDOW_MS 跑一次，只读 `clientState.peers`
 * （不自己调 easytier-cli：心跳已经在每 10 秒拉一次，重复调用只是白开机房进程）。
 *
 * **判据只有一条链路：本机 → 房主**（见 lib/relay-fallback.ts 的 hostLinkQuality）。
 * 为什么不是"所有直连节点里最差的那条"：`cost = p2p` 只说明本机到那个节点是直连，
 * 平台中继节点也常常是直连 —— 上一版就是这样把"到中继服务器的直连"当成
 * "玩家间的 P2P"，房间里四条连接全是中继节点却在报 P2P 丢包。
 * 玩家能感知到的回弹只来自跑着游戏服务端的房主那台机器，所以只有它能驱动回落。
 *
 * 阶段流转（括号里是停留时长）：
 *   watch(≥3 个窗口) --超标--> ab(20s) --中继不差--> serving(退避档) --到点--> probing(36s)
 *                                    \--中继更差--> watch + 冷却 30 分钟
 *   probing --到房主的直连恢复--> watch（退避归零）   \--还是差--> ab（退避翻倍）
 */
function guardTick(): void {
  const session = state.session;
  if (!session) {
    stopRelayGuard();
    return;
  }
  /**
   * 本机就是房主 → 自动回落**永不触发**。
   *
   * 判据是"到房主那条链路"，而房主没有"到房主"的链路（没有到自己的连接这回事）：
   * 这里显式退掉，而不是靠"peer list 里匹配不到自己"这种副作用 —— 后者一旦
   * 哪天多出一条同地址的记录（中继回环、EasyTier 行为变化）就会误触发，
   * 而误触发的代价是玩家被无故断流几秒。
   */
  if (session.isHost) {
    resetGuard('off');
    return;
  }
  // 正在换配置：这一刻的 peers 是半新半旧的，什么都不能判
  if (state.relaySwitching) return;
  if (!state.autoFallback) {
    resetGuard('off');
    return;
  }
  // 玩家自己钉住的中继：自动化让位，绝不替他撤销
  if (state.forceRelay && state.forceRelaySource === 'manual') {
    resetGuard('off');
    return;
  }
  // 核心没在跑（启动失败/被踢/切换中）：这一轮采样没有意义，也不该清零观察
  if (state.coreStatus?.state !== 'running') return;

  const now = Date.now();
  const hostIp = sessionHostVirtualIp(session);
  const quality = hostLinkQuality(state.peers, hostIp);
  /** A/B 基线：只有到房主那一条。切换前后比的就是"我到房主"这条路的前后 */
  const hostBaseline = (): RouteSample[] => {
    const route = hostRoute(state.peers, hostIp);
    return route ? [route] : [];
  };

  if (guard.phase === 'off') resetGuard('watch');

  if (guard.phase === 'watch') {
    if (state.forceRelay) {
      resetGuard('off');
      return;
    }
    if (now < guard.cooldownUntil) {
      guard.streak = 0;
      return;
    }
    /*
     * 这一窗**没有可判断的对象**（lossRate 为 null）→ 窗口作废：既不累加也不清零。
     * 三种情况都落在这一支，且都不该动手：
     *   · peer list 里还没有房主（刚进房、还没建链路）；
     *   · 到房主当前走的是中继（已经在走中继了，再"强制走中继"什么也改变不了）；
     *   · 那条链路的丢包读数还没测出来（不拿未知当证据）。
     */
    if (quality.lossRate === null) return;
    if (!quality.over) {
      guard.streak = 0;
      return;
    }
    guard.streak += 1;
    if (guard.streak < TRIGGER_WINDOWS) return;
    guard.baseline = hostBaseline();
    guard.deadline = now + AB_OBSERVE_MS;
    guard.phase = 'ab';
    void setForceRelay(true, 'auto');
    return;
  }

  if (guard.phase === 'ab') {
    // 玩家中途自己关了 → 这次判断作废
    if (!state.forceRelay) {
      resetGuard('off');
      return;
    }
    if (now < guard.deadline) return;
    if (relayLooksWorse(guard.baseline, hostBaseline())) {
      guard.cooldownUntil = now + AB_REVERT_COOLDOWN_MS;
      state.relayNotice = '中继反而更差，已切回 P2P 直连；30 分钟内不再自动切换。';
      resetGuard('watch');
      void setForceRelay(false, 'auto');
      return;
    }
    guard.deadline = now + guard.probeDelayMs;
    guard.phase = 'serving';
    return;
  }

  if (guard.phase === 'serving') {
    if (!state.forceRelay) {
      resetGuard('watch');
      return;
    }
    if (now < guard.deadline) return;
    // 放一次 P2P 重试：关掉 flag 让它重新打洞
    guard.deadline = now + SAMPLE_WINDOW_MS * TRIGGER_WINDOWS;
    guard.phase = 'probing';
    void setForceRelay(false, 'auto');
    return;
  }

  // probing
  if (state.forceRelay) {
    // 观察期内又被判成更差 → 直接回到 ab，不重复计数
    guard.deadline = now + AB_OBSERVE_MS;
    guard.phase = 'ab';
    return;
  }
  if (now < guard.deadline) return;
  if (quality.lossRate !== null && !quality.over) {
    state.relayNotice = `到房主的直连已恢复（丢包 ${formatLoss(quality.lossRate)}），继续走直连。`;
    guard.probeDelayMs = PROBE_BASE_MS;
    resetGuard('watch');
    return;
  }
  // 还是差 → 重新降级，并把下一次重试推远一档
  guard.probeDelayMs = nextProbeDelay(guard.probeDelayMs);
  guard.baseline = hostBaseline();
  guard.deadline = now + AB_OBSERVE_MS;
  guard.phase = 'ab';
  void setForceRelay(true, 'auto');
}

function startRelayGuard(): void {
  stopRelayGuard();
  guard.phase = 'watch';
  guard.streak = 0;
  guard.probeDelayMs = PROBE_BASE_MS;
  guard.timer = window.setInterval(guardTick, SAMPLE_WINDOW_MS);
}

function stopRelayGuard(): void {
  if (guard.timer !== null) {
    window.clearInterval(guard.timer);
    guard.timer = null;
  }
  resetGuard('off');
}

/**
 * 自动回落开关（设置页那一项）。
 *
 * 关掉时**不动当前状态**：已经切到中继的继续用中继（那是既成事实，
 * 悄悄切回去又是一次几秒断流，玩家只会觉得"关了设置反而断了一下"）。
 * 只让它不再做新的判断。
 */
export function setAutoFallback(on: boolean): void {
  state.autoFallback = on;
  saveAutoFallback(on);
  if (on && state.session) {
    startRelayGuard();
  } else {
    stopRelayGuard();
  }
  if (!on) {
    guard.cooldownUntil = 0;
    guard.probeDelayMs = PROBE_BASE_MS;
  }
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

  /**
   * 「局域网广播直通」在非 Windows 上不可用 —— 这是**第二道闸**（第一道在界面上：
   * RoomPage 的下拉框已置灰）。
   *
   * 为什么还要拦一次：房间可能是别的平台建的（策略里 allowBroadcast 本来就是 true），
   * 或者将来多出别的调用点。为什么**抛错而不是悄悄改成 false**：
   * 悄悄改会让玩家以为开关生效了，然后在 Minecraft 的「多人游戏」列表里干等 ——
   * 这正是「不要静默失败」要消灭的那种体验。错误会被 RoomPage 就地显示出来。
   */
  if (!supportsLanBroadcast && patch.allowBroadcast === true) {
    throw new Error(
      `「局域网广播直通」在当前平台不可用：它依赖 Windows 的 WinDivert 内核驱动。请用「直接连接 + 房间地址」联机。`,
    );
  }

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
    wsAttempts = 0;
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
    /**
     * 重连退避必须**带抖动 + 递增**。
     *
     * 原来是写死的 4 秒：主控重启（或一次卡顿）后，所有玩家的客户端会在同一秒
     * 一起回来。主控是单线程的，刚恢复就被这一波打满，新连接的 SYN 排不进
     * accept 队列 —— nginx 侧看到的就是同一秒里一批不同 IP 的 /ws
     * "upstream timed out while connecting"（线上日志实测），掉线 → 一起重连 → 再掉线。
     */
    wsAttempts += 1;
    wsReconnect = window.setTimeout(() => connectRealtime(), reconnectDelayMs(wsAttempts));
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
      if (message) {
        emitRoomChat({ type: 'message', message });
        notifyIfNeeded(message);
      }
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

/* ------------------------------------------------- 发消息提醒（系统通知） */

/**
 * 「有人在房间里说话 → 要不要弹系统通知」的**唯一判定点**。
 *
 * 为什么放在这里（而不是 ChatPanel 或某个 watcher）：
 *   · 这是消息**从 WS 进来**的唯一入口（上面 handleServerEvent 的 room.message 分支），
 *     判定挂在这里就天然保证"只有真的收到别人的消息才可能弹" ——
 *     界面重渲染、历史补齐（GET messages）、自己发言的回显都绕不到它，
 *     不会出现"刚进房间哗地弹一串通知"那种事故；
 *   · 「看着那个房间吗」（RoomPage 写的 roomOnScreen）、「窗口在前台吗」
 *     （渲染进程自己的 document.hasFocus）、「开关开着吗」（用户偏好）
 *     三件事在这里汇合成完整上下文，规则本身是纯函数（lib/notify-policy.ts），
 *     能在 node 里逐条断言，不必靠"在真机上碰运气"。
 *
 * 为什么不做成"发送时顺手弹"：那是**自己**发的消息 —— 界面里已经有回显，
 * 提醒自己说过什么毫无意义（判定里的 'self' 分支就是钉这件事的）。
 *
 * 真正"弹"的动作在主进程（Electron Notification）：点通知要把窗口叫回来、
 * 再让渲染层跳到房间，那是主进程才做得到的事。
 */
function notifyIfNeeded(message: ChatMessage): void {
  try {
    handleIncomingMessage(message, {
      sessionRoomId: state.session?.room.id ?? null,
      selfUserId: state.user?.id ?? null,
      roomName: state.session?.room.name ?? '',
    });
    // 进批之后由 notify.ts 的合并窗口决定什么时候真的发出去（几秒内的连发合并成一条）
  } catch {
    /* 提醒失败绝不能影响聊天本身：这条链路上的任何异常都在这里咽掉 */
  }
}

/**
 * 仅供自动化测试：把一条"服务器推来的"原始事件喂进**同一条**处理链。
 *
 * 它调用的就是 WS 用的那个 handleServerEvent —— 不是另写一条测试旁路，
 * 所以断言到的东西与线上是同一条路径（见 .cache/verify-notify-cdp.mjs）。
 */
export function handleServerEventForTest(raw: string): Promise<void> {
  return handleServerEvent(raw);
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

/**
 * 以管理员身份重启。
 *
 * 返回结果（而不只是写进 state.lastError）：调用处要能**就地**显示失败原因 ——
 * 用户实测"按了没用"就是因为失败原因只出现在顶部错误条，弹窗里什么都没变。
 */
export async function relaunchElevated(): Promise<{ ok: boolean; error?: string }> {
  const res = await window.mclink.relaunchElevated();
  if (!res.ok) state.lastError = res.error ?? '提权失败';
  return res;
}

export function clearError(): void {
  state.lastError = null;
}

export function clearKicked(): void {
  state.kickedReason = null;
}
