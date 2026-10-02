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
  isDirectLink,
  kbpsToBytesPerSecond,
  linkKind,
  type Room,
  type RoomAccess,
  type RoomMember,
  type RoomPolicy,
  type RoomTicket,
  type RoomVisibility,
  type RelayEndpoint,
  type RelayLatencyHint,
} from '@mclink/shared';
import { createHash } from 'node:crypto';
import type { ServerConfig } from '../config.ts';
import type { AppEventBus } from '../app.ts';
import { HttpError } from '../util/errors.ts';
import { logger } from '../logger.ts';
import { randomBytesBuf, shortId } from '../util/id.ts';
import { buildLaunchArgs, renderAcl, renderEasytierToml, rpcPortalForListenPort, usableRpcPort, CONFIG_PLACEHOLDER, type AclSpec } from '../easytier/config.ts';
import { buildRoomAcl } from '../easytier/acl.ts';
import { RoomRepo, toMember, toRoom, toRoomForUser, type JoinedRoomRow, type MemberRow } from '../db/rooms.ts';
import { NodeRepo, type NodeRow } from '../db/nodes.ts';
import { nodeClientEndpoint } from '../db/nodes.ts';
import { UserRepo } from '../db/users.ts';
import { AuditRepo } from '../db/traffic.ts';
import { MessageRepo } from '../db/chat.ts';
import { assertEmailVerified } from './email-gate.ts';
import type { SettingsService } from './settings.ts';
import { NodeUtilization, shedUtilFor, UTIL_SHED } from './node-utilization.ts';

const log = logger('rooms');

/**
 * 带宽利用率阈值由 `node-utilization.ts` 统一给出（`UTIL_SHED` = 90%，小带宽节点更低）。
 * 这里有本地常量会与它分叉 —— 状态机与调度必须用同一条线，所以直接 import。
 */
/** 降级节点的罚分：够大，能压过权重差异，但不会把它彻底排除（兜底时仍然可用） */
const DEGRADED_PENALTY = 100;

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
  /**
   * 客户端选择的 RPC 端口（只监听 127.0.0.1）。
   *
   * 为什么让客户端挑而不是主控推算：RPC 端口要绑在**玩家自己的机器**上，
   * 而 Windows 里「看起来空着」的端口可能落在 Hyper-V / WSL / Docker 保留的
   * 端口段内（`netsh int ipv4 show excludedportrange protocol=tcp`），
   * 显式绑定会直接 WSAEACCES(10013)。排除段只有本机知道，所以由客户端探测后上报，
   * 主控只负责校验范围；没带这个参数时回退到按 listenPort 推算（老客户端兼容）。
   */
  rpcPort?: number;
  ttlMinutes?: number | null;
  /**
   * 用户手选的节点 id（可空 = 自动调度）。
   * 校验不过时**降级为自动**并把原因放进结果里，而不是让建房失败 ——
   * 选错节点不该挡住玩家开游戏。
   */
  nodeIds?: string[];
  /**
   * 客户端建房前实测的节点延迟提示（可选，见 `RelayLatencyHint`）。
   *
   * 只影响两件事：**自动调度选谁**、以及**兜底节点排在哪台**。
   * 用户手选的 `nodeIds` 仍然优先（先手选、再补兜底），提示不会把用户的选择顶掉。
   *
   * ⚠️ 它现在的定位是**次键**：调度排序以 `weight`（运营方权重）为第一判据，
   * 只有权重完全相同才比延迟（见 `selectRelays` 的排序键）。
   * 因此**老客户端（不发这个字段）的选择结果也变了** —— 详见 `selectRelays` 的注释。
   */
  latencyHints?: RelayLatencyHint[];
}

export interface JoinResult {
  room: Room;
  member: RoomMember;
  ticket: RoomTicket | null;
  pending: boolean;
  /**
   * 仅建房时有：手选节点的落地结果（accepted / rejected+原因 / fallback）。
   * 客户端据此提示"你选的节点被拒了，已降级为自动"，而不是静默换掉用户的选择。
   */
  nodeSelection?: {
    requested: string[];
    accepted: string[];
    rejected: Array<{ id: string; reason: string }>;
    fallback: string | null;
  };
}

/** 心跳上报的一条 peer 记录：客户端只报这三项，够判定「直连还是中继」与延迟 */
export interface PeerReport {
  ipv4: string;
  cost: string;
  latencyMs: number | null;
}

/** 成员的链路结论：体感延迟 + 是否真的直连 */
export interface MemberLink {
  latencyMs: number | null;
  p2p: boolean;
}

function stripCidr(ip: string): string {
  return ip.replace(/\/\d+$/, '');
}

/** 延迟最低的那条 peer 记录；一条都没测到延迟时返回 undefined */
function fastestPeer(rows: PeerReport[]): PeerReport | undefined {
  let best: PeerReport | undefined;
  for (const row of rows) {
    if (row.latencyMs === null) continue;
    if (!best || best.latencyMs === null || row.latencyMs < best.latencyMs) best = row;
  }
  return best;
}

/**
 * 从成员上报的 peer 列表里判定「体感延迟 + 是否直连」。
 *
 * 只认**到房主**那一条：房间里的游戏流量走的就是成员↔房主。
 * 修正的 bug：EasyTier 对**经中继的路由同样会报 lat_ms**，以前把「有延迟」当成直连，
 * 于是走中继的成员在房间管理里被一律标成了 P2P（用户实测反馈）。
 * 现在只看 peer 行的 cost，规则与客户端诊断面板共用（`@mclink/shared` 的 linkKind）。
 *
 * 房主那一行没有「到房主」的链路，退化成它看到的最快成员（仍有参考价值：房主侧到玩家的延迟），
 * 但**不**声称自己直连。
 */
export function resolveMemberLink(rows: PeerReport[], hostIp: string, isHost: boolean): MemberLink {
  const remote = rows.filter((peer) => linkKind(peer.cost) !== 'local');
  const picked = isHost ? fastestPeer(remote) : remote.find((peer) => stripCidr(peer.ipv4) === hostIp);
  return {
    latencyMs: picked?.latencyMs ?? null,
    p2p: !isHost && picked !== undefined && isDirectLink(picked.cost),
  };
}

/**
 * 调度打分（纯函数，便于单测）。
 *
 * `weight × min(人数余量, 带宽余量) − 降级罚分`
 *
 * 两个余量取**最小值**：它们各自都能独立把节点顶死 —— 200 个 peer 的节点即使没什么流量
 * 也接不了新房间（每个 peer 都要握手与维护路由），而只有 5 个 peer 但跑满 5Mbps 的节点
 * 同样不行。以前只算人数余量，于是"5 个 peer 的满带宽节点"会被当成最优选择（用户实测反馈）。
 */
export function relayScore(row: NodeRow, utilization: number): number {
  const peerHeadroom = Math.max(0, row.capacity_peers - row.peers) / Math.max(1, row.capacity_peers);
  const bwHeadroom = freeBandwidth(utilization);
  const penalty = row.status === 'degraded' ? DEGRADED_PENALTY : 0;
  return row.weight * Math.min(peerHeadroom, bwHeadroom) - penalty;
}

/**
 * 空余带宽比例 `1 − utilization`（夹到 0–1）。
 *
 * 它与 `relayScore` 里的带宽余量、以及档内决胜的键 ③ 是**同一个量**，
 * 所以口径只在这里写一次，别处都调它 —— 三处各算一遍迟早会漂。
 * 注意它**只**看带宽：档内先比它，是因为延迟已经落在 5ms 之内（见 LATENCY_TIE_BAND_MS），
 * 那点差别不值得纠结，而"这台还有多少带宽"是实打实的。
 */
export function freeBandwidth(utilization: number): number {
  return 1 - Math.min(1, Math.max(0, utilization));
}

/**
 * 延迟并列带（ms）：实测延迟落在同一段区间内的候选就算「同一档」，
 * 交回「**大管子优先** → 空余带宽 → relayScore」决胜。
 *
 * 为什么是 10ms（2026-10-03 用户定的）：
 *   · 客户端的 tcping 是**3 次 TCP 握手取最快**，同城/同网节点的重复测量抖动典型只有 1–3ms，
 *     10ms 足够盖住这点噪声，又不至于把"确实差了一截（20ms+）"的节点也算成并列；
 *   · 档内的第一判据是**大管子优先**（用户的原话："差距如果在 10ms 内，就大管子优先"）：
 *     既然差不到 10ms，就别为了那几毫秒让一台 2 Mbps 的小管子去扛整个房间 ——
 *     它很快就会到卸荷线，房间还得再搬一次。**超过 10ms 则仍以近的为准**（延迟是主键）。
 *
 * ⚠️ 语义是**区间极差**，不是两两比较：同一档 = 一段连续区间，
 * 区间内 `(最大 ms − 最小 ms) ≤ 本带子`。用户的原话是"取各个节点的差值，差值不超过 10ms
 * 才算同一档"，但那**不满足传递性**（0/4/8：0↔4 ✓、4↔8 ✓、0↔8 ✗），
 * 拿它当排序依据会让结果依赖引擎的比较次数（同样的输入可能排出不同结果）。
 * 用区间极差实现则稳定、可复现，而且语义更严格：
 * 一档里最远的两台相差也不超过 10ms，任意两台自然都在带内。
 */
export const LATENCY_TIE_BAND_MS = 10;

/** 调度候选：节点行 + 该节点当前的带宽利用率（由调用方采样传入，好让下面的选择函数保持纯） */
export interface RelayCandidate {
  row: NodeRow;
  /** 带宽利用率 0–1 */
  utilization: number;
  /**
   * 这台节点自己的「不再接新房间」阈值（见 `node-utilization.ts` 的 `shedUtilFor`）：
   * 小带宽节点是 80%（可配），其余是 90%。不传时按 90% 处理（纯函数层向后兼容）。
   */
  shedUtil?: number;
}

/**
 * 一个候选此刻是否**真的还能接新房间**：人数与带宽两道余量都得有。
 *
 * 它决定两件事：
 *   1. 「延迟提示算不算数」—— 满员/吃紧的节点即使有提示也不参与延迟比较；
 *   2. 排序的**第 0 个键**（`selectRelays`）—— 真有余量的节点排在满员/吃紧的节点前面。
 *      这一条不是"偏好"而是硬条件的延伸：weight 高只能决定"同样能用时先选谁"，
 *      不能把一台接不了新房间的节点顶到队伍最前面（否则带提示的新客户端会比老客户端选得更差）。
 *
 * 它**不**用来把节点筛出候选池：真的一个有余量的节点都没有时，
 * 满员/吃紧的节点照旧按 weight → relayScore 兜底，房间拿到的中继数量与形态完全不变。
 */
function hasHeadroom(candidate: RelayCandidate): boolean {
  const shed = candidate.shedUtil ?? UTIL_SHED;
  return candidate.row.peers < candidate.row.capacity_peers && candidate.utilization < shed;
}

/**
 * 这台算不算「大管子」（**只用于延迟并列带内的决胜**，不再当候选池门槛）。
 *
 * 门槛是平台设置里的 `relayBigPipeBps`（默认 10 Mbps，控制台标签「小带宽节点门槛」）；
 * **`capacity_bps = 0`（控制台里没填带宽上限）也算大管子** —— 那个字段在界面上就是"不限"，
 * 把它当成小管子会让默认部署（没人填容量）全部落到"没有大管子"。
 * `thresholdBps <= 0` 时一律算大管子 = 关掉这条决胜。
 *
 * ⚠️ 它**不**用来把节点筛出候选池：2026-10-03 用户线上实测"有 2/5 Mbps 的近节点，
 * 房间却总落到 200 Mbps 的远节点"，根因就是那道"只看大管子"的候选池门槛 —— 已删除。
 * 现在它只在延迟差 ≤ `LATENCY_TIE_BAND_MS`（10ms）时说话：既然差不到 10ms，就用大管子。
 */
export function isBigPipeNode(row: NodeRow, thresholdBps: number): boolean {
  const capacity = row.capacity_bps ?? 0;
  if (capacity === 0) return true;
  return thresholdBps <= 0 || capacity >= thresholdBps;
}

/** 参与排序的候选：把排序键预先算好，免得比较器里反复查表 */
interface RankedCandidate {
  candidate: RelayCandidate;
  /** 键 0：真有余量（还能接新房间） */
  headroom: boolean;
  /** 键 ②（延迟并列带内第一个比）：是不是大管子（能扛得住整个房间） */
  big: boolean;
  /** 键 ③（延迟与大小都并列时才看）：运营方权重 */
  weight: number;
  /** 键 ①：实测延迟 ms；`+∞` = 没有提示（延迟未知，排在最后） */
  ms: number;
  /** 键 ②（只在延迟并列带内比）：空余带宽 `1 − utilization`，越大越优先 */
  bwFree: number;
}

/**
 * 从候选池里挑中继节点（纯函数，便于单测）：**延迟优先，延迟同档再看空余带宽**。
 *
 * 排序键（依次比较，前一条能分出胜负就不看后面）：
 *   0. **真有余量**（`hasHeadroom`）的排前面 —— 硬条件的延伸，不是偏好（理由见该函数注释）。
 *      真的一个有余量的候选都没有时（`scheduleRelays` 的带宽回退分支），它们之间照旧按 ①–④ 排。
 *   ① 有提示且真有余量的按 `ms` 升序 —— **主键**（"谁离建房这个人近就用谁"）；
 *      没有提示的排在最后（没提示 = 延迟未知，不优待）
 *   ② **延迟落在并列带内（区间极差 ≤ `LATENCY_TIE_BAND_MS` = 10ms）时，先比"是不是大管子"**
 *      —— 用户 2026-10-03："差距如果在 10ms 内就大管子优先"。既然差不到 10ms，
 *      就别让 2 Mbps 的小管子去扛整个房间（它很快会到卸荷线，房间还得再搬一次）
 *   ③ 同档内再比空余带宽 `1 − utilization` 降序（同样是大管子时，挑更空的那台）
 *   ④ 仍相同 → `relayScore` 降序（= weight × min(人数余量, 带宽余量) − 降级罚分）——
 *      这一步才轮到**权重**：它是运营方的意图，用来在"远近、大小、空余都一样"时定胜负
 *   ⑤ 仍相同 → `peers` 升序（改造前就有的收尾判据，保证同分结果稳定）
 *
 * ⚠️ 2026-10-03 用户改口径：**权重不再是主键**（原来是"权重优先、同权重才比延迟"）。
 * 理由是他线上实测到的现象：只有 200 Mbps 那台被选中，而 2/5 Mbps 的近节点连候选都进不去
 * （那是"大带宽档门槛"干的，那道**候选池**门槛已删）；他要的是"**延迟优先**"——
 * 建房的人测出来哪台最近就用哪台；但**10ms 之内**要让位给大管子（这条就是键 ②）。
 * 代价照实说：一台运营方并不想用的节点，只要离建房的人近（且不输在大小上）就会拿到这个房间。
 *
 * 硬条件一条都不放松：候选池由调用方按状态/禁用/权重/带宽/区域/卸荷线筛好，本函数既不放松也不新增 ——
 * 提示里出现池外节点（被停用、权重 0、离线、别区域、已过卸荷线…）时那条提示自然无效，
 * 拼接过的 nodeId 也拉不进任何东西。
 *
 * ⚠️ **老客户端（不发 `latencyHints`）**：一律落在 `ms = +∞` 那一队，
 * 顺序 = relayScore（权重 × 余量）→ peers，与大管子/延迟这两条都无关。
 */
export function selectRelays(
  candidates: readonly RelayCandidate[],
  hints: readonly RelayLatencyHint[] | null | undefined,
  max: number,
  /** 「算大管子」的门槛（`relayBigPipeBps`）；`<= 0` = 关掉档内的"大管子优先" */
  bigPipeThresholdBps = 0,
): NodeRow[] {
  const limit = Math.min(max, candidates.length);
  if (limit <= 0) return [];

  // 同一个 nodeId 出现多次时取最小值：与客户端「连打 3 次取最快」的语义保持一致
  const hintMs = new Map<string, number>();
  for (const hint of hints ?? []) {
    if (!hint || typeof hint.nodeId !== 'string' || hint.nodeId.length === 0) continue;
    if (typeof hint.ms !== 'number' || !Number.isFinite(hint.ms) || hint.ms < 0) continue;
    const prev = hintMs.get(hint.nodeId);
    if (prev === undefined || hint.ms < prev) hintMs.set(hint.nodeId, hint.ms);
  }

  const score = (candidate: RelayCandidate): number => relayScore(candidate.row, candidate.utilization);
  /** 键 ④⑤：分数降序，同分看 peer 少的（改造前就在用的比较规则） */
  const byScore = (a: RelayCandidate, b: RelayCandidate): number => score(b) - score(a) || a.row.peers - b.row.peers;
  /**
   * 键 ②③④：**档内决胜** —— 大管子优先 → 空余带宽降序 → byScore（含权重）。
   *
   * 为什么大管子排第一：延迟已经落进 10ms 的并列带（`LATENCY_TIE_BAND_MS`），
   * 为那几毫秒让一台 2 Mbps 的管子扛整个房间不划算（80% 就到卸荷线，房间马上又得搬）；
   * 为什么空余带宽排第二：同为够用的管子时，"这台还剩多少带宽"是实打实的事实。
   * 人数余量与降级罚分留给 byScore，口径不重复。
   */
  const byBand = (a: RankedCandidate, b: RankedCandidate): number =>
    Number(b.big) - Number(a.big) || b.bwFree - a.bwFree || byScore(a.candidate, b.candidate);
  /** 提示只在"真的还能接新房间"的节点上算数（见 hasHeadroom） */
  const hintedMs = (candidate: RelayCandidate): number | undefined =>
    hasHeadroom(candidate) ? hintMs.get(candidate.row.id) : undefined;

  const ranked: RankedCandidate[] = candidates.map((candidate) => ({
    candidate,
    headroom: hasHeadroom(candidate),
    big: isBigPipeNode(candidate.row, bigPipeThresholdBps),
    weight: candidate.row.weight,
    ms: hintedMs(candidate) ?? Number.POSITIVE_INFINITY,
    bwFree: freeBandwidth(candidate.utilization),
  }));

  /**
   * 第一趟：键 0 → ①（+ 一个稳定的收尾键）。
   *
   * 这一趟只负责把**档序**排出来：同余量的节点按 ms 升序，好让第二趟切"连续区间"。
   * 收尾键是 `byScore`（权重 → 空余 → peers），所以**没上报延迟的那一队（ms = +∞）**
   * 内部就是"权重高者优先"；有提示的档会在第二趟被 byBand 重排，这里排成什么不影响结果。
   * sort 是稳定的：完全并列的候选保持调用方给的顺序。
   */
  ranked.sort(
    (a, b) =>
      Number(b.headroom) - Number(a.headroom) ||
      // 两边都没提示时 `+∞ - +∞ = NaN`，而 NaN 在比较器里的行为是实现定义的 → 显式判等
      (a.ms === b.ms ? 0 : a.ms - b.ms) ||
      byScore(a.candidate, b.candidate),
  );

  /**
   * 第二趟：只在**键 0（有没有余量）相同**的连续区间内做"延迟并列带"。
   *
   * 为什么按"连续区间"而不是两两比较来判定并列：`|a-b| ≤ 带子` 不满足传递性
   * （0ms/4ms/8ms 里首尾相差 8ms 却各自与前一个"并列"），拿它当比较器会让排序结果
   * 依赖引擎的比较次数（同一份输入可能排出不同结果）。第一趟已经按延迟排好序，
   * 这里取一段"最高与最低相差 ≤ 带子"的连续区间（**区间极差**，见常量注释），
   * 区间内任意两个节点自然都在带子内，语义与结果都稳定、可复现。
   *
   * 带子内部不是按延迟排 —— 顺序由 byBand（空余带宽 → 打分）决定，
   * 所以「主中继」= 这一档里最空的那台，而不是"最快但快得没意义"的那台。
   */
  const picked: NodeRow[] = [];
  for (let start = 0; start < ranked.length; ) {
    const head = ranked[start];
    if (!head) break;
    // 切出「同余量」的连续区间：跨区间的胜负在第一趟就已经定了（有余量的整体在前）
    let stop = start + 1;
    while (stop < ranked.length) {
      const next = ranked[stop];
      if (!next || next.headroom !== head.headroom) break;
      stop += 1;
    }

    let cursor = start;
    while (cursor < stop) {
      const bandHead = ranked[cursor];
      if (!bandHead) break;
      if (!Number.isFinite(bandHead.ms)) {
        // 剩下的全是无提示节点：第一趟已经把它们按打分排好了，直接收尾
        // （没上报延迟的节点永远排在最后，不参与档内决胜 —— 本轮没动这条）
        for (; cursor < stop; cursor += 1) {
          const rest = ranked[cursor];
          if (rest) picked.push(rest.candidate.row);
        }
        break;
      }
      let end = cursor + 1;
      while (end < stop) {
        const ms = ranked[end]?.ms ?? Number.POSITIVE_INFINITY;
        if (!Number.isFinite(ms) || ms - bandHead.ms > LATENCY_TIE_BAND_MS) break;
        end += 1;
      }
      // sort 稳定：档内并列（空余带宽与打分都相同）的节点保持延迟升序，不会因为决胜把更低延迟的挤到后面
      const band = ranked.slice(cursor, end).sort(byBand);
      for (const entry of band) picked.push(entry.candidate.row);
      cursor = end;
    }
    start = stop;
  }
  return picked.slice(0, limit);
}

/**
 * 「活跃即续期」：算出这次心跳该把到期时间顺延到什么时候，不必写库时返回 null。
 *
 * 语义：**存活时长 = 无人活跃多久之后过期**，而不是"建房那一刻起算的硬期限"。
 * 所以只要房里还有人在心跳（客户端 10 秒一次），到期时间就一直被推着走；
 * 房间真正过期只有一种情况 —— 连续这么久没人活跃（含所有人都掉线了）。
 *
 * 为什么带 `minMove` 节流：每 10 秒写一次 expires_at 是纯浪费（写放大且毫无意义），
 * 期限只在"已经走过去一小段"时才值得写。节流窗口取 TTL 的 1/10、上限 5 分钟、
 * 下限 5 秒 —— 短 TTL（比如测试里的 1 分钟）也能正常滑动。
 */
export function nextRoomExpiry(current: string | null, nowMs: number, ttlMs: number): string | null {
  if (!current || !(ttlMs > 0)) return null; // 没设 TTL 的房间本来就不会过期
  const currentMs = Date.parse(current);
  const target = nowMs + ttlMs;
  if (!Number.isFinite(currentMs)) return new Date(target).toISOString();
  const minMove = Math.min(5 * 60_000, Math.max(5_000, ttlMs / 10));
  return target - currentMs >= minMove ? new Date(target).toISOString() : null;
}

/**
 * 「**节点整体**到线」的判定（纯函数，单测直接钉住）：**EWMA 或最近一次原始采样**任一越过卸荷线。
 *
 * 为什么两个都要看（用户 2026-10-03 问"超线一分钟就弹对吧"，发现只有 EWMA 太慢）：
 *   · 只用 EWMA（时间常数 3 分钟）：贴着容量跑的小管子要 ~5 分钟才爬过 80% 线，
 *     再加窗口计数就是 6 分钟才提醒 —— 玩家早卡了半天；
 *   · 只看最近一次原始采样：一次资源包下载/存档同步的脉冲就会误报。
 * 两个取**或**：脉冲靠后面的"连续 2 轮"（≈1 分钟）滤掉，而"真的持续超线"最快 1 分钟就提醒。
 */
export function nodeAtShedLine(ewmaUtil: number, rawUtil: number, shedUtil: number): boolean {
  return Math.max(ewmaUtil, rawUtil) >= shedUtil;
}

/**
 * 「房间自己跑出来的量」到线要连续多少轮（30 秒一轮 → 6 轮 ≈ 3 分钟）。
 *
 * 为什么不是一次就动：房间刚建好、玩家在下载资源包、有人刚进服，都会让瞬时速率冲高，
 * 单窗口触发等于把抖动当成长时间过载。3 分钟也够一个"真的在跑大流量"的房间暴露出来。
 * 回落用同一个窗口数（防抖，别来回切）。
 */
export const RELAY_SCALE_WINDOWS = 6;

/**
 * 「**节点整体**利用率到线」要连续多少轮（30 秒一轮 → 2 轮 ≈ 1 分钟）。
 *
 * 为什么比上一条短得多（用户 2026-10-03 问"要持续卡三分钟才收到通知吗"）：
 * 节点利用率是**已经平滑过**的信号（`NodeUtilization` 的 EWMA，时间常数 3 分钟），
 * 它不可能瞬时冲高；再叠 6 轮窗口等于双重平滑，等到通知发出去房间已经卡了好几分钟。
 * 1 分钟足够滤掉单次采样的毛刺（心跳 20 秒一次，两轮 = 至少 2 个采样点都在线上）。
 *
 * ⚠️ 光靠 EWMA 还是慢（贴线跑要 ~5 分钟才爬过线），所以见 `nodeAtShedLine`：
 * **最近一次原始采样**越过线也算，于是"真的超线"大约 1 分钟就会提醒。
 */
export const RELAY_NODE_BUSY_WINDOWS = 2;

/**
 * 有符号的窗口计数：到线 +1；**没到线则清零到 −1**（不是慢慢往回扣）。
 *
 * 语义是"**连续**到线了多少轮"：中途掉一轮就重新数（`+5 → −1`）——
 * 真实负载本来就有起伏，但"抖一下"不该被当成"已经持续超载 5 轮"。
 * 负数那一侧表示"已经连续空闲这么多轮"，回落分支（`<= -RELAY_SCALE_WINDOWS`）用它。
 * 抽成纯函数是为了把这条"清零"的行为写死：改成 `prev - 1` 会让"每 3 分钟超一次"
 * 的房间在几小时后突然被判定过载。
 */
export function advanceLoadWindows(prev: number, over: boolean): number {
  return over ? Math.max(prev, 0) + 1 : Math.min(prev, 0) - 1;
}

/**
 * 「节点负载到线、但暂时没得换」这条通知的**冷却时间**。
 *
 * 这是纯打扰信息（既没有切换、也不需要玩家做什么），所以同一房间 10 分钟内最多响一次 ——
 * 玩家正打着游戏，每 3 分钟"叮咚"一下只会让人烦躁。真正的切换建议（`kind: 'switch'`）
 * 不受这个冷却限制：那条 `#scaled` 只在一次切换准备好之后才会置位，不会重复响。
 */
export const RELAY_NOTICE_COOLDOWN_MS = 10 * 60_000;

/**
 * 房间"到线"之后该做什么（纯函数，单测直接钉住）。
 *
 * 三种结果：
 *   · `switch` —— 确实存在更空闲的节点 → 准备切换（等房主点）；
 *   · `notice` —— 没得换，但离上次打扰已经超过冷却时间 → 只通知玩家（说明卡是节点负载）；
 *   · `skip`   —— 已经准备好过一次（`prepared`），或者刚通知过（冷却内）→ 什么都不做。
 *
 * 用纯函数是因为这里的组合最容易写歪：`prepared` 与冷却时间两条短路条件少一条，
 * 结果就是"每 3 分钟叮咚一次"或者"准备好了却反复准备"。
 */
export function relayLoadAction(input: {
  /** 有没有"确实更空"的可换节点 */
  better: boolean;
  /** 已经准备好过一次切换了吗（`#scaled` 里有这个房间） */
  prepared: boolean;
  /** 上一次"到线了但没得换"的通知时间（0 = 从没通知过） */
  lastNoticeAt: number;
  now: number;
}): 'switch' | 'notice' | 'skip' {
  if (input.prepared) return 'skip';
  if (input.better) return 'switch';
  return input.now - input.lastNoticeAt >= RELAY_NOTICE_COOLDOWN_MS ? 'notice' : 'skip';
}

/**
 * 这个房间里**还有人在真的走中继**吗（纯函数，单测直接钉住）。
 *
 * 用户 2026-10-03 的规则：「如果房间内所有成员都是 p2p 打洞，那就不发任何通知」——
 * 道理很直白：成员与房主直连时，他们的流量根本不经过中继，那台中继忙不忙与他们无关，
 * 这时候弹横幅 + 响提示音只会让人莫名其妙。
 *
 * 判据用的是主控已有的 `member.p2p`（心跳里由 `resolveMemberLink` 按 EasyTier 的 `cost`
 * 判定"到房主这条链路是不是真直连"，见那里的注释）：
 *   · 只算 **active 的非房主成员** —— 房主自己不经过中继（他连的是别人），
 *     待审批/已踢出的人也不算；
 *   · **一个成员都没有** → 也返回 false（房间里没别人，没人需要被通知）；
 *   · 只要有一个成员不是 p2p（或者还没上报过 `p2p`）就算"在用中继" —— 宁可多提醒一次，
 *     也别在真的有人卡着的时候一声不吭。
 */
export function roomUsesRelay(
  members: ReadonlyArray<{ role: string; status: string; p2p: number | boolean | null }>,
): boolean {
  const guests = members.filter((m) => m.status === 'active' && m.role !== 'host');
  if (guests.length === 0) return false;
  return !guests.every((m) => m.p2p === 1 || m.p2p === true);
}

/**
 * 这名成员的票据中继是不是**已经落后于房间当前的中继**了（纯函数，单测直接钉住）。
 *
 * 用在心跳里：单节点模型下"换中继"＝整房搬走，房主点完「现在切换」之后，
 * 其他成员还连在旧节点上（旧节点已经没有到房主的路）—— 主控不主动踢他们，
 * 但每次心跳都如实告诉他们"该重连了"，客户端据此弹横幅 + 响一声。
 *
 * 三个"不算"：
 *   · 房主：他的票据就是房间当前中继，永远一致；
 *   · 还没分配过（`null`）：老成员/刚审批通过，下一次拉票据会自动补上，不是"变了"；
 *   · 房间当前没有中继（空数组）：那是另一种故障，不该说成"换过了"。
 */
export function memberRelayStale(
  roomRelayIds: readonly string[],
  memberRelayId: string | null,
  isHost: boolean,
): boolean {
  if (isHost) return false;
  if (!memberRelayId) return false;
  if (roomRelayIds.length === 0) return false;
  return !roomRelayIds.includes(memberRelayId);
}

/**
 * 取房间的中继（单节点模型）：**延迟优先 → 延迟同档比空余带宽 → 卸荷线是硬条件**。
 *
 * ⚠️ 2026-10-03 用户删掉了这里原来的"大带宽档门槛"（`relayBigPipeBps` 那道过滤）：
 * 他线上建房时明明有 2 Mbps / 5 Mbps 的近节点，房间却总落到 200 Mbps 的河北 ——
 * 因为 2M/5M 都低于 10 Mbps 门槛，**连候选池都进不去**，等于"延迟优先"根本没机会生效。
 * 现在只按 `selectRelays` 的规则挑（延迟优先，权重退到最后的兜底），
 * 那道门槛只留在**卸荷线**上（判断"这台算不算小管子"，小管子 80% 卸荷）。
 *
 * 延迟用的是**建房那个客户端上报的 tcping**（`latencyHints`）：它测的正是
 * "这台机器到我这条链路"，而房间的中继就是给这个房间的人用的。
 *
 * 模块级函数（不是类私有方法）是为了让单测能用假对象直接钉住这套规则
 * —— 见 `test/unit.test.ts` 的 `schedule()`。
 */
export function pickRelayNode(
  pool: readonly RelayCandidate[],
  latencyHints: readonly RelayLatencyHint[],
  excludeId: string,
  zone = '',
  /** 「算大管子」的门槛（延迟 10ms 档内优先用它）；见 `selectRelays` */
  bigPipeThresholdBps = 0,
): NodeRow | null {
  const rest = pool.filter((c) => c.row.id !== excludeId);
  if (rest.length === 0) return null;
  return selectRelays(rest, latencyHints, 1, bigPipeThresholdBps)[0] ?? null;
}

/**
 * 取房间的中继：**单节点模型**（2026-09-30 起）。
 *
 * 为什么不再分"两个槽位"：双槽（槽 1 打洞 / 槽 2 中继）完全依赖 EasyTier 的 avoid-relay
 * 惩罚把数据从槽 1 挤到槽 2，而实测（`scripts/repro-easytier-avoid-relay.mjs`，探针版
 * 二进制打印了发布/读取/边表）这个惩罚**只对"同网 peer"可靠**：当那台节点是
 * "代转外来网络的 public server"（＝我们房间的形态）时，约一半的运行里对端仍会选它，
 * 而且**不自愈** —— 于是房间整片走那台不承载的节点、数据被丢掉。
 *
 * 单节点模型下房间里根本没有第二条可被误选的路：
 *   · **所有节点都允许中继**（生成配置不再写 `disable_relay_data`）；
 *   · 小带宽节点靠**卸荷阈值**停止接新房间：`shedUtilFor(capacity_bps, …)` 是硬条件，
 *     选中台的时候就把它挡在候选之外（小管子 80%、其余 90%，见平台设置）；
 *   · 已经在跑的房间**不受影响**；要换机器靠"过载换槽"（`maybeSwapOverloadedRelay`），
 *     它只改后续进房的人拿到的票据。
 */
export function pickRoomRelays(
  zonePool: readonly RelayCandidate[],
  allPool: readonly RelayCandidate[],
  latencyHints: readonly RelayLatencyHint[],
  max: number,
  zone = '',
  /** 「算大管子」的门槛（只用于延迟 10ms 档内的决胜）；见 `selectRelays` */
  bigPipeThresholdBps = 0,
): string[] {
  if (max <= 0) return [];
  /*
   * 房间用的是单节点（调用方传 max = 1）。这里保留"多台"的分支是为了让**排序规则**
   * 本身可测、也可复用（`test/unit.test.ts` 的「延迟优先调度」一组就是按多台来断言排序的）
   * —— 单纯按 `selectRelays` 的顺序取前 max 台，不再有"打洞/中继"的角色之分。
   */
  if (max > 1) return selectRelays(zonePool, latencyHints, max, bigPipeThresholdBps).map((n) => n.id);
  const local = zonePool.length > 0 ? pickRelayNode(zonePool, latencyHints, '', zone, bigPipeThresholdBps) : null;
  if (local) return [local.id];
  /*
   * 本区域一台都挑不出来（都过了卸荷线 / 被硬条件挡掉）→ 跨区兜底。
   * 不兜底的话，某个区域的小管子全到线时那个区域就完全建不了房。
   */
  const cross = pickRelayNode(allPool, latencyHints, '', zone, bigPipeThresholdBps);
  if (!cross) return [];
  log.warn('本区域没有可用的中继节点，已从其它区域调一台', { zone, candidates: allPool.length });
  return [cross.id];
}

/**
 * 房主票据里下发几台中继 —— **1 台**（单节点模型，2026-10-03 用户拍板回归）。
 *
 * 为什么从"最多 3 台"退回 1 台（当时实测发现的洞）：
 *   · 票据里的 `[[peer]]` 只是**初始引导节点**，不是"只许连这些"的白名单；
 *   · EasyTier 是张网状网：成员连上自己那台之后，会通过它学到整个房间的路由表，
 *     而房主同时连着那 3 台 —— 于是成员照样能和**另外两台**建立直连，并按代价最小选路，
 *     数据完全可能走那两台（用户安卓端实测：成员同时握着到 3 台的直连，见
 *     `docs/relay-assignment.md` 的"为什么会学到另外两台"）；
 *   · 想让"只走分给自己那台"成立，代价机制（`avoid_relay_data`）粒度是**节点级全局**、
 *     且在我们这种"代转外来网络的 public server"形态下**时灵时不灵**（复现见
 *     `scripts/repro-easytier-avoid-relay.mjs`），靠不住。
 * 只有房间里**只有一台**中继时，上述路径问题才从结构上消失：没有第二台可被误选。
 * 代价（明确接受）：一台节点忙了，房间只能整体搬走（见 `promoteOverloadedRooms` 的通知），
 * 不能像"≤3 台"那样把新成员摊到别的节点上。
 */
export const RELAY_SET_SIZE = 1;

/**
 * 组出房间的中继集合（**最多 `size` 台**，生产用 1 —— 见 `RELAY_SET_SIZE`）。
 *
 * 规则：手选的第一台优先，剩下的由自动调度补齐；去重、截断到 `size`；
 * 没进集合的手选节点如实记进 `rejected` 让界面说清楚。
 *
 * 单节点模型下这里就是"手选第一台，其余如实告诉用户被忽略"；
 * 保留 `size` 参数是为了单测能按多台钉住排序规则本身（那也是 `pickRoomRelays` 的用法）。
 *
 * 纯函数，单测直接钉住（`test/unit.test.ts`）。
 */
export function pickRoomRelaySet(
  picked: readonly { id: string }[],
  auto: readonly string[],
  size = RELAY_SET_SIZE,
): { relays: string[]; rejected: Array<{ id: string; reason: string }> } {
  const relays: string[] = [];
  for (const p of picked) {
    if (relays.includes(p.id)) continue;
    if (relays.length < size) relays.push(p.id);
  }
  for (const id of auto) {
    if (relays.length >= size) break;
    if (!relays.includes(id)) relays.push(id);
  }
  const rejected = picked
    .filter((p) => !relays.includes(p.id))
    .map((p) => ({ id: p.id, reason: `一个房间最多 ${size} 台中继，这台已忽略` }));
  return { relays, rejected };
}

/**
 * 手选节点与自动调度结果合并成**一个**中继（单节点模型的全部规则）。
 *
 * 以前这里是 `assignRelaySlots`（按能力把多台手选节点排进两个槽位）。单节点模型下
 * "槽位"这个概念没有了：**手选的第一台生效，其余忽略并如实告诉界面**；没手选就用自动调度的第一台。
 *
 * 纯函数，单测直接钉住（`test/unit.test.ts`）。
 */
export function pickRoomRelay(
  picked: readonly { id: string; name?: string }[],
  auto: readonly string[],
): { relay: string | null; rejected: Array<{ id: string; reason: string }> } {
  const first = picked[0];
  if (first) {
    return {
      relay: first.id,
      rejected: picked.slice(1).map((p) => ({
        id: p.id,
        reason: '一个房间只下发一台中继，多余的已忽略（单节点模型）',
      })),
    };
  }
  return { relay: auto[0] ?? null, rejected: [] };
}

/**
 * 成员分中继时「延迟算同一档」的带宽（ms）—— 用户 2026-10-02 定的口径：
 * **延迟优先，相差 10ms 以内视为同一档，档内取空余带宽最大的那台**。
 *
 * 为什么和 `LATENCY_TIE_BAND_MS`（5ms，用于**房间**选中继）不是一个数：
 *   · 房间选中继用的是**房主**测的延迟，那是"这个房间走哪台"的长期决定，宁可挑更近的；
 *   · 成员分中继是给**每个成员**各挑一台，候选只有房间那 ≤3 台，选错了后果也只是一次两跳路径，
 *     而且成员多、并发高，10ms 的带子能让负载更均匀地摊开（同城几台常有 5–15ms 的抖动，
 *     5ms 的带子会把它们硬分出高下，10ms 则允许"谁空谁接"）。
 * 两者的共同点：都是**区间极差**（一段连续区间内最大减最小 ≤ 带子），不是两两比较 ——
 * 后者不满足传递性，会让结果依赖比较顺序（理由见 `LATENCY_TIE_BAND_MS` 的注释）。
 */
export const MEMBER_RELAY_TIE_BAND_MS = 10;

/**
 * 「卡」折成延迟的**默认汇率**（ms / 100% 利用率）—— 平台设置 `relayLoadPenaltyMs` 可覆盖。
 *
 * 为什么需要它（用户 2026-10-02 追问："他客户端学到的是握手延迟，根本不知道谁卡了"）：
 * 成员的 tcping 只证明"路不远"，证明不了"那台不忙" —— 一台跑到 80% 的中继握手照样 5ms。
 * 真正知道谁卡的是主控自己（节点心跳 rx/tx ÷ capacity_bps 的 EWMA 利用率），
 * 所以把利用率按这个汇率折进成本：**40 = 跑满等于远了 40ms**（80% 等于 32ms）。
 * 于是 20ms 的空管子赢过 5ms 但 80% 忙的管子（5+32=37 > 20），
 * 而两台都空着时**仍然是纯延迟优先**（口径不变）。
 */
export const MEMBER_RELAY_LOAD_MS = 40;

/** `pickMemberRelay` 的结果：选中的那台 + 两个"解释性"标志（调用方据此记日志） */
export interface MemberRelayPick {
  /** 选中的中继 id；候选为空时为 null */
  id: string | null;
  /** 候选**全部**过了卸荷线，这次是兜底（"不能没人可分"，调用方记一条 warn） */
  allShed: boolean;
  /** 这次真的用上了这名成员上报的延迟；false = 只按"谁更空/更不忙"选 */
  usedHints: boolean;
}

/**
 * 给**成员**挑一台中继（纯函数，单测直接钉住）。口径见 `docs/relay-assignment.md`：
 *
 *   ① **硬过滤**：利用率已经**到达卸荷线**（`utilization >= shedUtil`，小管子 80%、其余 90%）
 *      的中继直接排除 —— "到卸载线的就排出去"。这是硬条件，延迟再好也不破例；
 *   ② **成本 = 延迟 + 汇率 × 利用率**（`loadPenaltyMs`，默认 40）：这才是"快不快"的完整口径 ——
 *      成员的 tcping 只说得出"路远不远"，说不出"那台卡不卡"，而主控从节点心跳里知道；
 *   ③ **10ms 以内算同一档**（`MEMBER_RELAY_TIE_BAND_MS`，按**成本**切）→ 档内取**空余带宽最大**的那台；
 *   ④ **没有延迟数据的中继排在最后**：只要有候选带提示，就在带提示的那批里选
 *      （"没测到"不是"延迟 0" —— 与 `selectRelays` 的语义一致）。
 *
 * 全过线时的兜底：**只有**这时才把过了线的候选放回来，按"最空的"选并置 `allShed` ——
 * 屋里一台都没得选时，给一个刚过线的中继，也比让成员没有票据、直接进不去房间好。
 *
 * 与 `selectRelays`（房间选中继）的区别仍然只有一个：那一套是**权重优先**（运营方的意图优先，
 * 延迟只在同权重内比较）；这里是**延迟（含拥堵折价）优先**。
 * 之所以能这么分：房间选中继决定了整个房间走哪台，值得听运营方的；成员分中继只是
 * "在房间里已经定好的那几台之间摊开"，成员自己的体感才是唯一该优化的东西。
 *
 * ⚠️ `utilization` 只有在节点声明了 `capacity_bps` 时才非 0（没填 = 不限，算不出来），
 * 所以**没填容量的节点不吃这个折价** —— 想让它生效就得在控制台给节点填带宽上限。
 */
export function pickMemberRelay(
  candidates: readonly RelayCandidate[],
  hints: readonly RelayLatencyHint[] | null | undefined,
  /** 「卡」折成延迟的汇率（ms / 100% 利用率）；平台设置 `relayLoadPenaltyMs`，0 = 关掉 */
  loadPenaltyMs = MEMBER_RELAY_LOAD_MS,
): MemberRelayPick {
  if (candidates.length === 0) return { id: null, allShed: false, usedHints: false };

  // 同一个 nodeId 取最小值：与客户端「连打 3 次取最快」一致（口径与 selectRelays 相同）
  const hintMs = new Map<string, number>();
  for (const hint of hints ?? []) {
    if (!hint || typeof hint.nodeId !== 'string' || hint.nodeId.length === 0) continue;
    if (typeof hint.ms !== 'number' || !Number.isFinite(hint.ms) || hint.ms < 0) continue;
    const prev = hintMs.get(hint.nodeId);
    if (prev === undefined || hint.ms < prev) hintMs.set(hint.nodeId, hint.ms);
  }

  /**
   * 这台此刻的"有效延迟"：握手延迟 + 拥堵折价。
   *
   * 折价用的就是卸荷线同一个量（`utilization`），所以口径只有一份：
   * 越接近卸荷线，折价越大（40% 忙 = 远了 16ms，80% = 32ms），到线就整个排除。
   */
  const rate = Number.isFinite(loadPenaltyMs) && loadPenaltyMs > 0 ? loadPenaltyMs : 0;
  const costOf = (c: RelayCandidate): number => rate * Math.min(1, Math.max(0, c.utilization));

  /* ① 卸荷线：`>=` 是"到达即不再接新负载"，与 NodeService 的状态判定同一条线 */
  const below = candidates.filter((c) => c.utilization < (c.shedUtil ?? UTIL_SHED));
  const allShed = below.length === 0;

  /**
   * ②④ 延迟（含折价）优先：只在"带提示"的那批里挑；一台都没提示时才整池参与。
   *
   * ⚠️ 全过线（`allShed`）时**不看延迟** —— 那时已经没有"没到线的"可选，延迟不再是判据，
   * 只看谁还剩一点（延迟好的那台恰好也最满，正是最不该再塞人的情况）。这也让
   * `usedHints` 的语义保持诚实：它只在真的用延迟做过决定时为 true。
   */
  let pool: readonly RelayCandidate[] = below;
  let usedHints = false;
  if (allShed) {
    pool = candidates;
  } else {
    const hinted = pool.filter((c) => hintMs.has(c.row.id));
    usedHints = hinted.length > 0;
    if (usedHints) {
      /** 成本 = 成员测到的握手延迟 + 这台此刻的拥堵折价 */
      const cost = (c: RelayCandidate): number => hintMs.get(c.row.id)! + costOf(c);
      let best = Number.POSITIVE_INFINITY;
      for (const c of hinted) best = Math.min(best, cost(c));
      /* ③ 区间极差 ≤ 10ms 的连续一段 = 同一档（按成本切） */
      pool = hinted.filter((c) => cost(c) - best <= MEMBER_RELAY_TIE_BAND_MS);
    }
  }

  /*
   * ④ 档内决胜：空余带宽最大者胜；完全并列时依次看 relayScore（含权重与降级罚分）、
   * peers、id —— 后面几个键只为**结果稳定可复现**（同样的输入永远选出同一台），
   * 尤其是"同一个房间的成员拿到的分配不该随候选顺序抖动"。
   */
  const order = (a: RelayCandidate, b: RelayCandidate): number =>
    freeBandwidth(b.utilization) - freeBandwidth(a.utilization) ||
    relayScore(b.row, b.utilization) - relayScore(a.row, a.utilization) ||
    a.row.peers - b.row.peers ||
    (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0);
  const chosen = [...pool].sort(order)[0];
  return { id: chosen?.row.id ?? null, allShed, usedHints };
}


export class RoomService {
  private readonly config: ServerConfig;
  private readonly rooms: RoomRepo;
  private readonly nodes: NodeRepo;
  private readonly users: UserRepo;
  private readonly audit: AuditRepo;
  private readonly settings: SettingsService;
  private readonly events: AppEventBus;
  private readonly messages: MessageRepo;
  /** 带宽利用率（与 NodeService 共享同一个实例） */
  private readonly util: NodeUtilization;

  /**
   * 过载自动提升用的内存状态（见 `promoteOverloadedRooms`）：
   *   · `#loadWindows`：有符号的连续窗口计数 —— 正数 = 持续超载，负数 = 持续空闲；
   *   · `#scaled`：已经提升过的房间（存着提升前的顺序与当时的读数，用于回落和界面显示）。
   * 主控重启即清空（房间短命，代价可忽略）。
   */
  readonly #loadWindows = new Map<string, number>();

  /**
   * 「那台节点**整体**到线」的窗口计数（与 `#loadWindows` 同样的有符号语义）。
   *
   * 单独一份的原因见 `RELAY_NODE_BUSY_WINDOWS`：节点利用率已经是平滑过的信号，
   * 判定它只需要 2 轮；而房间自己的瞬时吞吐要 6 轮。两个判据混用一个计数会让
   * "节点明明早就满了、却因为房间流量不高而一直不提醒"。
   */
  readonly #nodeWindows = new Map<string, number>();
  readonly #scaled = new Map<string, { previous: string[]; rxBps: number; txBps: number; at: number }>();

  /**
   * 「谁进房时上报了哪些节点延迟」的短命暂存（`roomId:userId` → hints）。
   *
   * 为什么需要暂存：分配发生在**第一次拉票据**时，而审批制房间的第一次拉票据发生在 join
   * **之后**（房主批准了才给票据），那一刻请求里已经没有 hints 了 —— 不暂存就等于
   * "审批过的房间永远按负载分配"，与"延迟优先"的口径不一致。
   *
   * 只放在内存里：它不是用户资料，丢了最多退回"按最空的选"（不影响可用性）；
   * 30 分钟过期、分配时取走即删，长跑进程里不会攒下无主记录。
   */
  readonly #joinHints = new Map<string, { hints: RelayLatencyHint[]; at: number }>();
  static readonly #HINTS_TTL_MS = 30 * 60_000;

  /**
   * 「已经挑好、但还没生效」的新中继（`roomId → nodeId`）。
   *
   * 为什么要有这层待生效状态（单节点模型的关键安全点）：房间里只有一台中继，
   * 换台 ＝ **整房搬走**。房主不先搬，成员先搬过去就找不到房主（那台节点上没有到房主的路），
   * 房间直接散架。所以过载时只**准备**目标并通知玩家，真正的落库发生在
   * **房主下一次拉票据**（他点「现在切换」或退出重进）那一刻；在此之前所有人的票据
   * 拿到的仍是旧中继，谁先重连都不会把自己弄丢。
   *
   * 内存态：主控重启就丢（房间短命，过载窗口计数同样是内存态，代价可忽略）。
   */
  readonly #pendingRelay = new Map<string, string>();

  /** 上一条"节点负载高、暂时没得换"的通知时间（同一房间 10 分钟内不重复打扰） */
  readonly #noticedAt = new Map<string, number>();

  /**
   * 排查用的日志节流（`房间:原因 → 上次打印时间`）。
   *
   * 过载判定 30 秒跑一轮，把"为什么没弹"每次都打出来会刷屏；但**完全不打**又让线上
   * 只能靠猜（用户实测踩过：节点 30%、线设 1%，日志里一个字都没有）。
   * 所以按"同一房间同一原因 10 分钟一条"记 info。
   */
  readonly #diagAt = new Map<string, number>();

  #diagAllowed(roomId: string, reason: string, cooldownMs = RELAY_NOTICE_COOLDOWN_MS): boolean {
    const key = `${roomId}:${reason}`;
    const now = Date.now();
    if (now - (this.#diagAt.get(key) ?? 0) < cooldownMs) return false;
    this.#diagAt.set(key, now);
    return true;
  }

  constructor(
    config: ServerConfig,
    rooms: RoomRepo,
    nodes: NodeRepo,
    users: UserRepo,
    audit: AuditRepo,
    settings: SettingsService,
    events: AppEventBus,
    messages: MessageRepo,
    util: NodeUtilization,
  ) {
    this.config = config;
    this.rooms = rooms;
    this.nodes = nodes;
    this.users = users;
    this.audit = audit;
    this.settings = settings;
    this.events = events;
    this.messages = messages;
    this.util = util;
  }

  /**
   * 往房间里写一条系统消息（谁进来了、谁被踢了…）。
   * 这些是「房间大事记」，和玩家发言一起出现在聊天流里，比单独的通知更好追溯。
   */
  systemMessage(roomId: string, text: string): void {
    try {
      const message = this.messages.add({
        roomId,
        userId: null,
        displayName: '系统',
        role: 'system',
        kind: 'system',
        body: text,
      });
      this.events.emit('room.message', { roomId, message });
    } catch (err) {
      // 系统消息失败不能影响主流程（比如房间刚好被删）
      log.warn('写入系统消息失败', { room: roomId, error: (err as Error).message });
    }
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
    // 邮箱门禁放在所有业务检查之前：没验证邮箱的账号连"配额用满了"都不该知道
    assertEmailVerified(user, s.requireEmailVerification);
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
    /**
     * 中继节点：**单节点模型** —— 一个房间只下发**一台**中继。
     *
     * 自动模式（没有手选）：`pickRoomRelays` 从本区域（挑不出就跨区兜底）挑一台，
     * 硬条件里已经包含"小管子过了卸荷线就不再接新房间"。
     *
     * 手动模式：建房页让玩家挑的就是那台中继，**手选的第一台直接生效**，
     * 多余的忽略并记进 `rejected` 让界面说清楚（规则本体是模块级纯函数 `pickRoomRelay`）。
     *
     * `latencyHints` 只喂给自动调度（同权重时决定先挑哪台）。
     *
     * ⚠️ **浮动切换是天然的，不需要状态机**：票据每次请求都现算，`utilization` 也是实时采样，
     * 所以"这台满了 → 下次先挑另一台"会在**下一张票据**里自动生效。
     * 已经进了房间的玩家**不会**因为这次切换被踢：他们的 peer 列表来自加入时那张票据。
     */
    const picked = this.#validatePickedNodes(input.nodeIds ?? []);
    const auto = this.scheduleRelays(zone, input.latencyHints ?? [], RELAY_SET_SIZE);
    const chosenSet = pickRoomRelaySet(
      picked.ids.map((id) => ({ id })),
      auto,
    );
    const relayNodeIds = chosenSet.relays;
    /** 平台挑的那台（不在手选名单里）—— 界面据此说明"平台补了谁" */
    const fallback = relayNodeIds.find((id) => !picked.ids.includes(id)) ?? null;
    const nodeSelection = {
      requested: input.nodeIds ?? [],
      accepted: picked.ids,
      rejected: [...picked.rejected, ...chosenSet.rejected],
      fallback,
      /**
       * 单节点模型：只有 `relay` 一个角色（`punch` 恒为 null）。
       * 界面与控制台都读它，别再靠数组下标去猜 —— 旧模型下 `[0]` 是"打洞节点"。
       */
      roles: { punch: null as string | null, relay: relayNodeIds[0] ?? null },
    };
    /**
     * 硬守卫：**一个可调度的子节点都没有，就不给建房**。
     *
     * 以前这里靠"主控自身中继还开着（`masterRelayAvailable`）"放行，于是单机部署时
     * 票据里会出现主控地址（反代在国内之外时下发的是反代那台）。主控兜底已取消、
     * 那个「主控中继实例」本身也在 2026-09-28 一并移除，就只剩"明确报错"这一条路：
     * 宁可不给建房，也不下发一个连不上的入口。
     * 文案要让玩家自己看得懂、也知道找谁 —— 客服照这句话就能判断是"平台没有在线子节点"。
     */
    if (relayNodeIds.length === 0) {
      throw HttpError.unavailable('当前没有可用的中继节点，暂时无法建房，请稍后再试或联系客服');
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
      // 存下房间自己的 TTL：到期时间会随活跃顺延，之后推不出该顺延多久（见 V14 迁移）
      ttlMinutes: ttlMinutes && ttlMinutes > 0 ? ttlMinutes : null,
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
    this.systemMessage(row.id, `房间已创建，加入码 ${code}。把加入码和联机地址发给朋友即可一起玩。`);

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
        input.rpcPort,
      ),
      pending: false,
      /**
       * 节点选择的实际结果（客户端建房页用）：
       * accepted = 真的用上的手选节点，rejected = 被拒的 + 原因，
       * fallback = 平台补的兜底节点。让界面能说清"你选的没用上、现在走哪台"，
       * 而不是静默降级。
       */
      nodeSelection,
    };
  }

  /* ------------------------------------------------------------ 加入 */

  join(input: {
    userId: string;
    code: string;
    password?: string | null;
    deviceName?: string | null;
    listenPort?: number;
    /** 见 CreateRoomInput.rpcPort */
    rpcPort?: number;
    /**
     * 这名玩家进房前测到的各节点延迟（**可选**，老客户端不发）—— 见 `CreateRoomInput.latencyHints`。
     *
     * 建房时它只用来排序；进房时它决定**这名成员被分到哪台中继**
     * （延迟优先，见 `pickMemberRelay`）。测不到就不发：主控会退回"在房间那几台里挑最空的"。
     */
    latencyHints?: readonly RelayLatencyHint[] | null;
  }): JoinResult {
    const row = this.rooms.findByCode(input.code.toUpperCase());
    if (!row) throw HttpError.notFound('加入码无效');

    const user = this.users.findById(input.userId);
    if (!user) throw HttpError.notFound('用户不存在');
    if (user.banned === 1) throw HttpError.forbidden('账号已被封禁');
    assertEmailVerified(user, this.settings.current.requireEmailVerification);
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
        ticket: this.ticket(
          row.id,
          input.userId,
          input.listenPort ?? this.settings.current.relayPort,
          input.rpcPort,
        ),
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
    /*
     * 先记住这轮上报的延迟，再拉票据 —— 分配发生在票据里（见 `ticket`）。
     * 审批制房间的票据要等房主批准之后才拉，那时请求里已经没有提示了，所以必须暂存
     * （内存、30 分钟过期、分好即删，见 `#rememberHints` / `#takeHints`）。
     */
    this.#rememberHints(row.id, input.userId, input.latencyHints);
    this.rooms.recalcCounts(row.id);
    this.rooms.touch(row.id);
    this.rooms.logAccess(row.id, input.userId, pending ? 'join_pending' : 'join', null, null);
    notifyChanged(this.events, row.id);
    this.systemMessage(
      row.id,
      pending
        ? `${user.display_name} 申请加入，等待房主审批。`
        : `${user.display_name} 加入了房间（虚拟地址 ${virtualIp.replace(/\/\d+$/, '')}）。`,
    );

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
    const ticket = pending
      ? null
      : this.ticket(
          row.id,
          input.userId,
          input.listenPort ?? this.settings.current.relayPort,
          input.rpcPort,
          // 进房这轮上报的延迟：决定这名成员被分到哪台中继（见 pickMemberRelay）
          input.latencyHints,
        );
    return {
      // 待审批时连房间对象也不能带网络名，否则「审批」这道门形同虚设
      room: toRoomForUser(fresh, input.userId),
      /*
       * ⚠️ 必须**重新读一次**成员行：分配就是在上面那次 `ticket()` 里写进
       * `room_members.relay_node_id` 的，用 `addMember` 返回的那一行会让响应里
       * `relayNodeId` 永远是 null（票据里已经有中继了，接口却说"没分"）。
       */
      member: toMember(this.rooms.findMember(row.id, input.userId) ?? member),
      ticket,
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
    const target = this.rooms.findMember(roomId, targetUserId);
    this.systemMessage(
      roomId,
      approve ? `${target?.display_name ?? '该成员'} 的加入申请已通过。` : `${target?.display_name ?? '该成员'} 的加入申请被拒绝。`,
    );
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
    this.systemMessage(roomId, `${member.display_name} 被移出房间（${reason}）。`);
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
    const leaver = this.users.findById(userId);
    this.systemMessage(roomId, `${leaver?.display_name ?? '有成员'} 离开了房间。`);
  }

  /* ------------------------------------------------------------ 关闭 */

  close(roomId: string, userId: string, byHost = false): void {
    const row = this.getRow(roomId);
    this.assertHost(row, userId);
    this.rooms.close(roomId, 'closed');
    this.rooms.logAccess(roomId, userId, 'close', byHost ? 'host' : 'api', null);
    // 房间关了就没有聊天语境了；清掉记录避免数据库被历史闲聊撑大
    this.messages.clearRoom(roomId);
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
   * 生成客户端启动 EasyTier 所需的一切。
   *
   * 中继地址**只**来自房间调度结果（`room.relayNodeIds` → 子节点的链接端口），
   * 主控自身不参与 —— 以前还有一条"主控兜底"，需要靠请求的 `Host` 头推导地址，
   * 那条路径与推导一起删掉了（`masterRelayEndpoint()` 已移除）。
   */
  ticket(
    roomId: string,
    userId: string,
    listenPort: number,
    /**
     * 客户端上报的 RPC 端口。校验放在 API 层（1024–65535），这里只做兜底：
     * 没给或明显不可用时按 listenPort 推算，保证老客户端与脚本调用照常工作。
     */
    rpcPort?: number | null,
    /**
     * 这名成员上报的节点延迟（可选）—— 只在**首次分配**时用得上，见 `pickMemberRelay`。
     * 传空/不传时回退到 join 时暂存的那一份（`#takeHints`），两者都没有就按"最空的"选。
     */
    latencyHints?: readonly RelayLatencyHint[] | null,
  ): RoomTicket {
    let row = this.getRow(roomId);
    const member = this.rooms.findMember(roomId, userId);
    if (!member || member.status === 'kicked') {
      throw HttpError.forbidden('你不在该房间中');
    }
    if (member.status === 'pending') {
      throw HttpError.forbidden('等待房主审批');
    }

    /*
     * 房主拉票据 = **换中继的唯一生效点**（见 `#pendingRelay` 的注释）：
     * 先落库，再把成员的分配合清掉（他们下次拉票据/重连时自动分到新那台），
     * 并在房间里留一条系统消息 —— 其他人看到就知道该重连了。
     * 成员拉票据**不会**触发它：成员先搬过去会找不到房主，房间就散架了。
     */
    if (row.host_user_id === userId && this.#applyPendingRelay(roomId)) {
      row = this.getRow(roomId);
    }

    const room = toRoom(row);
    const isHost = room.hostUserId === userId;
    /*
     * 中继集合**按角色**决定（`docs/relay-assignment.md`）：
     *   · 房主 → 房间的中继集合；
     *   · 成员 → 只有分配给他的那一台。
     * 单节点模型（`RELAY_SET_SIZE = 1`）下两者其实是同一台 —— 保留这个分叉是因为
     * "成员只连自己那台"这条不变式仍然由它保证（哪天集合重新变多台也不用改这里）。
     * 成员分配在**第一次拉票据时**定下来并写回 `room_members.relay_node_id` ✓：
     * 这样三条加入路径都不用各自接一遍调度，而且已经在房里的老成员下次拉票据也会自动补上分配。
     * 分配失败（比如一台都不可调度）时退回房间默认（`room.relayNodeIds[0]`）—— 也就是旧行为。
     */
    let assignedRelayId = member.relay_node_id ?? null;
    if (!isHost) {
      /*
       * 成员：在房间的中继集合里挑一台并**固定**下来。
       * 口径（用户 2026-10-02 定，`docs/relay-assignment.md`）：
       *   ① 已经**到达卸荷线**的中继直接排除（小管子 80%、其余 90%）；
       *   ② 剩下的按"成本 = 该成员自己上报的 tcping 延迟 + 负载折价"排队；
       *   ③ 相差 ≤ 10ms 视为同一档，档内取空余带宽最大的那台；
       *   ④ 没有延迟数据的中继排在最后。规则本体在纯函数 `pickMemberRelay` 里（有单测）。
       *
       * ⚠️ 单节点模型（`RELAY_SET_SIZE = 1`）下池子里只有一台，②③④ 自然用不上 ——
       * 那套排序是为"集合重新变多台"准备的（也是单测钉着的规则）。这里保留它，是因为
       * "分到的那台还在不在池子里"这个判断与重分逻辑与台数无关。
       *
       * 已经在房的成员**不再改分配**：换中继要断一次线，而卸荷线约束的是"接新负载"，
       * 已经在上面跑的成员不该被赶走（与节点侧"这条线只挡新房间"的口径一致）。
       * 只有"分到的那台已经不在房间集合里了"（节点被停用/换槽）才会重新分。
       */
      const pool = room.relayNodeIds.filter((id) => this.nodes.findById(id));
      if (pool.length > 0 && (!assignedRelayId || !pool.includes(assignedRelayId))) {
        const candidates: RelayCandidate[] = pool.map((id) => {
          const row = this.nodes.findById(id)!;
          return { row, utilization: this.utilizationOf(row), shedUtil: this.shedUtilOf(row) };
        });
        // 显式的提示优先；没有就用 join 时暂存的那一份（取走即删）
        const remembered = this.#takeHints(roomId, userId);
        const hints = latencyHints && latencyHints.length > 0 ? latencyHints : remembered;
        /*
         * 汇率（「卡」折成延迟）跟随平台设置：成员测到的握手延迟 + 汇率 × 该节点利用率。
         * 成员客户端测不出"卡"，负载只有主控知道（节点心跳的 EWMA），这一项就是把它接进来。
         */
        const pick = pickMemberRelay(candidates, hints, this.settings.current.relayLoadPenaltyMs);
        assignedRelayId = pick.id ?? pool[0] ?? null;
        if (pick.allShed) {
          log.warn('房间的中继都过了卸荷线，这名成员只能分到最空的那台', {
            room: roomId,
            user: userId,
            candidates: pool.length,
          });
        }
        if (assignedRelayId) this.rooms.setMemberRelay(roomId, userId, assignedRelayId);
        log.info('成员分配中继', {
          room: roomId,
          user: userId,
          relay: assignedRelayId,
          byLatency: pick.usedHints,
          // 把候选的实际读数记下来，事后能复盘"为什么分给了它"
          candidates: candidates.map((c) => ({
            id: c.row.id,
            ms: hints.find((h) => h.nodeId === c.row.id)?.ms ?? null,
            util: Number(c.utilization.toFixed(3)),
          })),
        });
      }
    }
    /** 房主连**整组**（每台都有一条直达房主的链路）；成员只连分到的那一台 */
    const assignedIds = isHost ? room.relayNodeIds : [assignedRelayId].filter((id): id is string => Boolean(id));
    const relayRows = this.nodes.findByIds(assignedIds);
    /*
     * 下发给客户端的端口必须是**链接端口**，不是节点本机的运行端口：
     * 节点在 NAT / 端口映射后面时（本机 11010、对外 21010），
     * 给客户端的地址只能是对外那个，否则客户端永远连不上。
     * 规则本体在 db/nodes.ts，节点服务生成配置时用的是同一份。
     */
    const relays: RelayEndpoint[] = relayRows.map((n) => {
      const endpoint = nodeClientEndpoint(n, this.settings.current.relayPort);
      const port = endpoint.slice(endpoint.lastIndexOf(':') + 1);
      const host = endpoint.slice(0, endpoint.lastIndexOf(':'));
      return {
        nodeId: n.id,
        region: n.region,
        label: n.name,
        url: `tcp://${host}:${port}`,
        udpUrl: `udp://${host}:${port}`,
        latencyMs: null,
      };
    });

    /*
     * 票据里的中继**只**来自房间调度结果（建房时写进 `room.relayNodeIds` 的那 1–2 个
     * 子节点）。以前这里还会追加一条"主控自身中继"当兜底，那条路径连同它的地址推导
     * （`masterRelayEndpoint()`，靠 `relayPublicHost → publicBaseUrl → Host 头` 猜地址）
     * 已经全部删除 —— 主控不再参与转发，也就不需要猜自己的地址了。
     */
    if (relays.length === 0) {
      /*
       * 房间建好之后它的节点全被停用/下线才会走到这里（建房时已经保证至少一个）。
       * 票据照发（客户端仍能起来），但没有可连的中继入口 —— 留一条 warn，
       * 让客服能按房间号在主控日志里查到"他为什么连不上"。
       */
      log.warn('票据里没有任何可用中继：房间的中继节点都不可用了', { room: roomId });
    }

    const virtualIp = member.virtual_ip ?? hostIpCidr(room.subnetSlot);
    const hostMember = this.rooms.findMember(roomId, room.hostUserId);
    const hostVirtualIp = (hostMember?.virtual_ip ?? hostIpCidr(room.subnetSlot)).replace(/\/\d+$/, '');

    /*
     * 客户端启动时至少要有 1 个中继入口，否则无法加入虚拟网络。
     * 主控不再兜底之后，`relays` 为空确实是可能的（见上面的 warn）——那时 peers 为空数组，
     * 客户端实例会起来但谁也连不上；这条不做二次兜底（用户明确要求不再加别的兜底路径），
     * 界面侧由房间页的「连不上」诊断与这条日志负责说清。
     */
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
         * **按代价选路，而不是按跳数**（EasyTier 的两套选路策略开关）。
         *
         * 必须打开，否则「只协助打洞」形同虚设：标了 `disable_relay_data` 的节点靠
         * `AVOID_RELAY_COST`（i32::MAX）被挤出候选，但那个代价**只在 LeastCost 策略下参与比较**；
         * 默认的 LeastHop（`latency_first = false`，见 `peer_manager.rs:1443-1449`）分支里
         * 只按跳数筛，`normalize_edge_cost` 那一层把惩罚边折进"最短跳数子图"之后，
         * "绕过它"和"经过它"同跳数时惩罚就白加了。
         *
         * 实测（两台中继：一台标了只协助打洞、一台可承载，两端各自与两台都是 p2p 直连）：
         * 打开前两端全部走那台**只打洞**的节点（`relay(2)`），数据被它丢掉、房间不通；
         * 打开后代价按延迟算，那台的 +2147483647 才会真正把它排出候选。
         */
        latencyFirst: true,
        /**
         * 关闭 bind_device。
         *
         * EasyTier 默认 `bind_device = true`，会把隧道的出站套接字绑定到指定网卡；
         * 在部分环境（受限容器、多网卡、Windows 沙箱）下会直接报
         * WSAEADDRNOTAVAIL(10049) 而完全无法连接中继。中继与子节点都显式关闭了它，
         * 客户端必须保持一致，否则玩家会「连上主控却进不了房间」。
         */
        bindDevice: false,
        /**
         * 固定虚拟网卡名。
         *
         * EasyTier 默认让系统自己命名，于是每次重装/重启都可能多出一张「以太网 3」
         * 「以太网 4」——玩家在 Windows 网络设置里认不出哪张是 McLink，旧网卡还会
         * 一直躺在那里。写死名字后重复连接复用同一张网卡，卸载时也只需要删这一张。
         *
         * 长度受约束：Linux 网卡名上限 15 字符，这里 5 个字符留足余量。
         */
        devName: 'McLink',
        /**
         * 局域网广播直通：**由房主的房间策略决定，默认关闭**。
         *
         * 打开它，MC 的「多人游戏」列表里能直接看到房间；但 Windows 上它要靠 WinDivert
         * 内核网络过滤驱动抓物理网卡的 UDP 广播 —— 等于给每个玩家的机器装一个系统级网络驱动，
         * 实测会与其它软件的网络栈冲突（有玩家反馈连上后网易云音乐等软件上不了网）。
         * 详情见 RoomPolicy.allowBroadcast 的注释。
         */
        enableUdpBroadcastRelay: room.policy.allowBroadcast,
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
        rpcPortal: `127.0.0.1:${usableRpcPort(rpcPort) ?? rpcPortalForListenPort(listenPort)}`,
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
  ): { kicked: boolean; aclToml: string | null; aclRevision: number; relayChanged: boolean } {
    const member = this.rooms.findMember(roomId, userId);
    if (!member) return { kicked: true, aclToml: null, aclRevision: 0, relayChanged: false };
    if (member.status === 'kicked') {
      return { kicked: true, aclToml: null, aclRevision: 0, relayChanged: false };
    }

    // 挑一条链路作为该成员的「体感延迟 + 链路类型」：判定逻辑在 resolveMemberLink（有单测）。
    // 以前这里是「有 lat_ms 就算直连」，于是走中继的成员在房间管理里显示成了 P2P。
    const row = this.rooms.findById(roomId);
    const hostMember = row ? this.rooms.findMember(roomId, row.host_user_id) : undefined;
    const hostIp = stripCidr(hostMember?.virtual_ip ?? hostIpCidr(row?.subnet_slot ?? 0));
    const { latencyMs: latency, p2p } = resolveMemberLink(
      payload.peers ?? [],
      hostIp,
      member.role === 'host',
    );

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

    /**
     * 「活跃即续期」：房间里还有人在心跳，就不该因为"存活时长到了"被解散。
     *
     * 以前 `expires_at` 是建房那一刻算死的硬期限，到点就被 30 秒一次的
     * `findExpired()` 关掉 —— **房里有人也照关**（虽然已建立的隧道不会立刻断，
     * 但新人再也进不来，房间在大厅里也消失了，语义很别扭）。
     * 现在期限跟着活跃走：只要有人心跳就顺延，真正过期的只有"连续 TTL 没人活跃"的房间。
     * 写库有节流（见 nextRoomExpiry），不是每 10 秒一次。
     */
    const ttlMs =
      (row?.ttl_minutes ?? this.settings.current.roomTtlMinutes ?? 0) * 60_000;
    const extended = nextRoomExpiry(row?.expires_at ?? null, Date.now(), ttlMs);
    if (extended && row?.status === 'open') {
      this.rooms.setExpiry(roomId, extended);
      log.debug('房间因活跃而顺延过期时间', { room: roomId, expiresAt: extended });
    }

    const revision = row?.acl_revision ?? 0;
    const isHostOfRoom = row?.host_user_id === userId;
    // ACL 只在版本变化时下发：房主每 10 秒收一份近 1KB 的 ACL 是纯浪费
    const needsAcl = isHostOfRoom && payload.aclRevision !== revision;
    return {
      kicked: false,
      aclToml: needsAcl ? this.aclToml(roomId) : null,
      aclRevision: revision,
      relayChanged: this.#relayChangedFor(row, member, isHostOfRoom === true),
    };
  }

  /**
   * 这名成员的票据中继**已经和房间现在的中继不一致**了吗（要重连才能用上新的）。
   *
   * 判定本体是纯函数 `memberRelayStale`（有单测：房主/未分配/房间没中继三种"不算"）。
   * 这里只负责把房间行解出来喂进去。
   */
  #relayChangedFor(row: JoinedRoomRow | undefined, member: MemberRow, isHost: boolean): boolean {
    if (!row) return false;
    return memberRelayStale(toRoom(row).relayNodeIds, member.relay_node_id ?? null, isHost);
  }

  /* ------------------------------------------------------------ 调度 */

  /**
   * 按区域挑选中继节点。
   *
   * 硬条件在这一层筛完（`listSchedulable` 的状态/禁用/权重 + 带宽余量 + 区域），
   * **延迟提示一条都不放松**；通过硬条件的节点交给纯函数 `selectRelays` 排序：
   * **权重降序 → 权重相同才比延迟 → 延迟并列带（区间极差 ≤5ms）内先比空余带宽
   * → relayScore → peers**（见那里的注释）。
   *
   * `max = 2` 时返回的就是两个**不同**节点（一次取前两名）；生产用的是 `RELAY_SET_SIZE = 1`
   * （单节点模型，见那里的注释），多台分支只留给单测钉排序规则。
   *
   * `latencyHints` 缺省（老客户端 / 改区域触发的重调度）＝ 权重优先、同权重再按 relayScore；
   * 注意这**不再**等于改造前的纯 relayScore 排序（权重成了第一判据，见 `selectRelays`）。
   * 指定区域时该区域无可用节点仍回退到全局（并记日志），
   * 避免玩家因为某个区域没部署节点而完全无法联机。
   *
   * ⚠️ 这里**不缓存**任何"谁被选中"的状态：每次调用都重新采样 `utilization` 并重新排序，
   * 所以"某台满了就换一台"是天然的浮动切换（下一张票据自动生效），不需要状态机。
   */
  scheduleRelays(zone: string, latencyHints: readonly RelayLatencyHint[] = [], max = RELAY_SET_SIZE): string[] {
    const all = this.nodes.listSchedulable();
    if (all.length === 0) return [];
    /**
     * 带宽利用率在这里采样一次，筛选与打分共用同一个值。
     * 两次调用会各读一次 EWMA —— 同一 tick 内结果相同，但写死"用的就是这一次采样"
     * 更不容易在以后加入 await 时出现"按 A 判定还有富余、按 B 打分"的错位。
     * 档内决胜（键 ③）用的也是这**同一个**值，不另采一次。
     */
    const candidates: RelayCandidate[] = all.map((row) => ({
      row,
      utilization: this.utilizationOf(row),
      shedUtil: this.shedUtilOf(row),
    }));

    /**
     * 带宽已吃紧的节点**这次不再分配新房间**：阈值按节点自己的档位算 ——
     * 小带宽节点 80%（可配，见 `shedUtilFor`），其余 90%。
     *
     * 这是"只影响新票据"的核心：不动已经跑着的房间，也不去改节点配置 ——
     * 改配置要重启该节点的 easytier-core，会把它上面所有房间一起抖断（秒级），
     * 为了缓解负载而制造一次全网瞬断是不划算的。房间是短命的（TTL + 空房回收），
     * 不再分配新房间就能让这台节点自然排空。
     *
     * 但如果**所有**候选都吃紧，就不能空手而归：那样新房间连一个中继都没有
     * （本轮又取消了主控兜底，确实没有第二条路了）。这时退回全量候选并记一条日志
     * （宁可挤一点，也别把房间挤没了）。注意这是**最后的手段**，不是"兜底节点"：
     * 它决定的只是"这一轮从哪些候选里挑"，房间拿到的仍然是前两名。
     */
    const relaxed = candidates.filter((c) => !this.isBandwidthBusy(c.row));
    const pool = relaxed.length > 0 ? relaxed : candidates;
    if (relaxed.length === 0) {
      log.warn('所有可用节点的带宽都已吃紧，回退到全量候选（新房间只能挤一挤）', { zone });
    }

    if (zone === 'auto') {
      return this.pickRelays(pool, pool, latencyHints, max, zone);
    }
    const inZone = pool.filter((c) => c.row.region === zone);
    if (inZone.length === 0) {
      log.warn('指定区域没有可用节点，回退到全局调度', { zone });
      return this.pickRelays(pool, pool, latencyHints, max, zone);
    }
    // 注意这里传的是**两个**池：区域池用于槽 1，全局池只在"本区域没有可承载节点"时给槽 2 兜底
    return this.pickRelays(inZone, pool, latencyHints, max, zone);
  }

  /** 小管子判定门槛（字节/秒）：低于它的节点按小管子卸荷（见 `shedUtilOf`）。
   *  2026-10-03 起它**只**用于卸荷线，不再参与"挑哪台当中继"。 */
  smallPipeThresholdBps(): number {
    return Math.max(0, this.settings.current.relayBigPipeBps);
  }

  /**
   * 取中继：转发给模块级 `pickRoomRelays`（那里是纯函数，便于单测钉规则）。
   * 这里只负责把平台设置读出来 —— `relayBigPipeBps` 现在是"算不算大管子"的门槛，
   * **只在延迟差 ≤10ms 那一档内**决定胜负（见 `selectRelays` 的键 ②）。
   */
  pickRelays(
    zonePool: readonly RelayCandidate[],
    allPool: readonly RelayCandidate[],
    latencyHints: readonly RelayLatencyHint[],
    max: number,
    zone: string,
  ): string[] {
    return pickRoomRelays(zonePool, allPool, latencyHints, max, zone, this.smallPipeThresholdBps());
  }

  /**
   * 校验用户手选的节点。
   *
   * 只接受**真的能承载流量**的节点：存在、未禁用、weight>0、status ∈ online/degraded。
   * 不满足的记进 rejected（带原因）交给上层回给客户端 —— 建房照常进行，降级为自动。
   *
   * 这里**不看延迟提示**：手选是用户的直接意图，只要节点合格就照用；
   * 提示只影响自动调度与兜底顺序（见 CreateRoomInput.latencyHints）。
   */
  #validatePickedNodes(ids: string[]): { ids: string[]; rejected: Array<{ id: string; reason: string }> } {
    const accepted: string[] = [];
    const rejected: Array<{ id: string; reason: string }> = [];
    for (const id of ids.slice(0, 3)) {
      const row = this.nodes.findById(id);
      if (!row) {
        rejected.push({ id, reason: '节点不存在' });
        continue;
      }
      if (row.disabled === 1) {
        rejected.push({ id, reason: '节点已被管理员禁用' });
        continue;
      }
      if (row.weight <= 0) {
        rejected.push({ id, reason: '节点未参与调度' });
        continue;
      }
      if (row.status !== 'online' && row.status !== 'degraded') {
        rejected.push({ id, reason: `节点当前${row.status === 'pending' ? '待接入' : '离线'}` });
        continue;
      }
      if (!accepted.includes(id)) accepted.push(id);
    }
    return { ids: accepted, rejected };
  }

  /* ------------------------------------------------------- 过载自动提升 */

  /**
   * 房间中继过载 → 把**槽 2（中继节点）换成更空的大带宽节点**。
   *
   * 触发：房间的中继速率（跨节点 rx+tx 之和）连续 `RELAY_SCALE_WINDOWS` 个窗口超阈值；
   * 回落：低于阈值同样连续这么多窗口才还原（防抖）。
   * 作用范围（用户明确接受）：**只影响新票据** —— 后来进房/重进房的人按新名单连，
   * 已经在房间里的人这一局不变（用户原话："原来的已经到负载边缘了，让后来的人走大宽带负载"）。
   *
   * 为什么换的是槽 2：新模型下槽 1 是打洞节点（`assist_only`，不承载数据），换它没有意义；
   * 而子节点之间没有互相 peer，同一房间的成员必须共享至少一台中继，所以打洞节点也不能动。
   * 换之前会确认"新那台确实更空"，否则保持不变（不为了动作而动作）。
   *
   * 状态全在内存：主控重启后重新开始计数（房间本来就短命，代价可忽略）。
   */
  promoteOverloadedRooms(
    samples: ReadonlyArray<{ networkName: string; rxBps: number; txBps: number }>,
    now = Date.now(),
  ): Array<{
    roomId: string;
    code: string;
    /** `switch` = 已准备好更空闲的中继（等房主点切换）；`notice` = 到线了但没得换，只通知 */
    kind: 'switch' | 'notice';
    to: string;
    from: string;
    /** 当前中继的名字（横幅文案用；客户端按角色拼，见 client/src/lib/relay-hint.ts） */
    currentLabel: string;
    /** 准备好的新中继名字；`notice` 时为 null（没有可换的） */
    targetLabel: string | null;
    /** 那台节点**整体**的利用率（0–1），日志与文案都用它 */
    nodeUtil: number;
    rxBps: number;
    txBps: number;
    message: string;
  }> {
    const threshold = Math.max(0, this.settings.current.relayScaleMbps) * 1_000_000;
    if (threshold <= 0) return [];

    /** 房间 → 这一轮的跨节点合计速率 */
    const rate = new Map<string, { rx: number; tx: number }>();
    for (const sample of samples) {
      const row = this.rooms.findByNetworkName(sample.networkName);
      if (!row) continue;
      const current = rate.get(row.id) ?? { rx: 0, tx: 0 };
      current.rx += Math.max(0, sample.rxBps);
      current.tx += Math.max(0, sample.txBps);
      rate.set(row.id, current);
    }

    const promoted: Array<{
      roomId: string;
      code: string;
      kind: 'switch' | 'notice';
      to: string;
      from: string;
      currentLabel: string;
      targetLabel: string | null;
      nodeUtil: number;
      rxBps: number;
      txBps: number;
      /** 给玩家的提示文案（客户端复用消息通知弹出来，切不切由玩家决定） */
      message: string;
    }> = [];
    for (const [roomId, r] of rate) {
      const total = r.rx + r.tx;

      const row = this.rooms.findById(roomId);
      if (!row || row.status !== 'open') continue;
      const current = toRoom(row).relayNodeIds;

      /*
       * **全是 p2p 直连的房间不打扰**（用户 2026-10-03 的规则，见 `roomUsesRelay`）：
       * 成员与房主直连时流量根本不经过中继，中继忙不忙与他们无关 ——
       * 既不发系统消息，也不推横幅、不响提示音。
       *
       * 这里记 info（不是 debug）：用户实测"节点 30%、线设 1% 却不弹"时，
       * 最常见的原因就是这个闸门（房间里没有成员、或成员全都直连房主）——
       * 默认日志级别下 debug 看不见，等于没有线索。同一房间 10 分钟一条。
       */
      const members = this.rooms.listMembers(roomId);
      if (!roomUsesRelay(members)) {
        if (this.#diagAllowed(roomId, 'p2p')) {
          log.info('中继到线判定：房间里没人真的走中继（全员 p2p 直连或没有成员），按规则不通知', {
            room: roomId,
            code: row.code,
            members: members.filter((m) => m.status === 'active' && m.role !== 'host').length,
            allP2p: members.length > 0 && members.filter((m) => m.status === 'active' && m.role !== 'host').every((m) => m.p2p === 1),
          });
        }
        continue;
      }

      /*
       * **每个房间的过载阈值 = min(平台门槛, 该房间中继那台自己的卸荷线)**。
       *
       * 为什么不能只看平台门槛：2 Mbps 的小管子永远到不了默认的 8 Mbps（现在兜底 2 Mbps），
       * 于是房间**永远不会被判定过载**、换槽永不触发 —— 用户实测：手选一台 2 Mbps，
       * 房间占满之后新进来的人还是拿同一台。按节点自己的线算（小管子 80% → 2 Mbps × 0.8
       * = 1.6 Mbps）才会在该卸的时候卸。平台门槛仍然作为上限，避免大管子被过早换掉。
       */
      const relayRow = current[0] ? this.nodes.findById(current[0]) : null;
      const relayCapBps = relayRow?.capacity_bps ?? 0;
      const shedLine = relayCapBps > 0 ? relayCapBps * this.shedUtilOf(relayRow!) : Number.POSITIVE_INFINITY;
      const roomThreshold = Math.max(1, Math.min(threshold, shedLine));
      /**
       * **两种"到线"都算过载**（用户 2026-10-03 的口径：「节点负载到了就通知」）：
       *   ① 这个房间自己跑出来的量 ≥ 房间阈值（原来的判据，按房间流量算）；
       *   ② 那台节点**整体**的利用率 ≥ 它自己的卸荷线 —— 上面还跑着别的房间，
       *      节点快满了，这个房间也该准备搬（单节点模型里"搬"＝整房换台）。
       * ② 的判定见 `nodeAtShedLine`：**EWMA 或最近一次原始采样**任一越线都算 ——
       * 只看 EWMA 的话"贴着容量跑"要 ~5 分钟才爬过线，玩家早卡半天了。
       *
       * 两条**各有各的窗口数**（阈值与理由见那两个常量）：
       *   ① 是本房间的瞬时吞吐，容易因为下载资源包冲高 → 要 6 轮（≈3 分钟）才算数；
       *   ② 要 2 轮（≈1 分钟）就够，否则"卡了三分钟才提醒"。
       */
      const ewmaUtil = relayRow ? this.utilizationOf(relayRow) : 0;
      const relayCap = relayRow?.capacity_bps ?? 0;
      // 最近一次心跳报上来的原始速率（不平滑）÷ 容量：用来抓"刚开始超线"的那一刻
      const rawUtil =
        relayRow && relayCap > 0 ? Math.min(1, Math.max(relayRow.rx_bps, relayRow.tx_bps) / relayCap) : 0;
      const nodeShed = relayRow ? this.shedUtilOf(relayRow) : UTIL_SHED;
      const nodeUtil = Math.max(ewmaUtil, rawUtil);
      const nodeBusy = relayRow !== null && nodeAtShedLine(ewmaUtil, rawUtil, nodeShed);

      const next = advanceLoadWindows(this.#loadWindows.get(roomId) ?? 0, total >= roomThreshold);
      this.#loadWindows.set(roomId, next);
      const busyNext = advanceLoadWindows(this.#nodeWindows.get(roomId) ?? 0, nodeBusy);
      this.#nodeWindows.set(roomId, busyNext);

      /**
       * **到线了但还在数窗口**时也留一条痕（同一房间 10 分钟一次）。
       *
       * 用户实测"节点 30%、卸荷线设成 1%，却一点动静没有"，而当时主控日志里什么都没有 ——
       * 只能靠猜是没到窗口、还是压根没进这个循环。现在这两种情况都能从日志里读出来。
       */
      if (nodeBusy && busyNext < RELAY_NODE_BUSY_WINDOWS && this.#diagAllowed(roomId, 'counting')) {
        log.info('中继到线：正在累计窗口（还没到就会弹）', {
          room: roomId,
          code: row.code,
          node: relayRow?.name ?? relayRow?.id ?? '(无)',
          nodeUtil: Number(nodeUtil.toFixed(3)),
          shedUtil: nodeShed,
          windows: `${busyNext}/${RELAY_NODE_BUSY_WINDOWS}`,
        });
      }

      if (next >= RELAY_SCALE_WINDOWS || busyNext >= RELAY_NODE_BUSY_WINDOWS) {
        /*
         * 单节点模型：房间只有一台中继，过载时**整房搬到更空的大管子**。
         * 注意这里只"准备"目标（`#pendingRelay`），真正的落库发生在房主下一次拉票据 ——
         * 成员先搬过去会找不到房主（见 `#pendingRelay` 的注释）。
         * 只在确实存在更空的候选时才搬，避免为了动作而动作。
         */
        const [relayId] = current;
        if (!relayId) continue;
        const currentRelay = this.nodes.findById(relayId);
        const currentFree = currentRelay ? freeBandwidth(this.utilizationOf(currentRelay)) : -1;
        const candidate = this.nodes
          .listSchedulable()
          .map((row) => ({ row, utilization: this.utilizationOf(row), shedUtil: this.shedUtilOf(row) }))
          .filter((c) => c.row.id !== relayId && !this.isBandwidthBusy(c.row))
          .sort((a, b) => freeBandwidth(b.utilization) - freeBandwidth(a.utilization) || b.row.weight - a.row.weight)[0];
        const better = candidate !== undefined && freeBandwidth(candidate.utilization) > currentFree;
        /** 该做什么由纯函数决定（准备好过 / 冷却中都短路，见那里的注释） */
        const action = relayLoadAction({
          better,
          prepared: this.#scaled.has(roomId),
          lastNoticeAt: this.#noticedAt.get(roomId) ?? 0,
          now,
        });
        if (action === 'skip') continue;
        if (action === 'notice') {
          /*
           * **没有更好的节点可换**，但节点确实到线了 —— 也要告诉玩家（用户明确要的：
           * "节点负载到了就客户端响一下"）。内容说实话：这台忙了、暂时没得换，
           * 让他们知道卡是节点负载而不是自己网络的问题。
           */
          this.#noticedAt.set(roomId, now);
          this.#loadWindows.set(roomId, 0);
          const percent = Math.round(Math.max(nodeUtil, relayCapBps > 0 ? total / relayCapBps : 0) * 100);
          const currentName = relayRow?.name ?? relayId;
          const message =
            `平台提示：当前房间使用的中继节点「${currentName}」已经到容量上限（约 ${percent}%），` +
            '可能会出现卡顿。目前没有更空闲的节点可以换，先忍一下；' +
            '稍后可以在房间页点「重连」再看一次，或让房主换个区域重新建房。';
          this.systemMessage(roomId, message);
          log.warn('房间中继节点负载到线，但没有更空的大带宽节点可换（已通知玩家）', {
            room: roomId,
            code: row.code,
            node: relayId,
            utilization: Number(nodeUtil.toFixed(3)),
          });
          promoted.push({
            roomId,
            code: row.code,
            kind: 'notice',
            to: relayId,
            from: relayId,
            currentLabel: currentName,
            targetLabel: null,
            nodeUtil,
            rxBps: r.rx,
            txBps: r.tx,
            message,
          });
          continue;
        }
        if (!candidate) continue; // 类型收窄（action === 'switch' 时 better 为真，必然有 candidate）
        this.#pendingRelay.set(roomId, candidate.row.id);
        this.#scaled.set(roomId, { previous: current, rxBps: r.rx, txBps: r.tx, at: now });
        this.#loadWindows.set(roomId, 0);
        /**
         * 给玩家一条**建议**（不是自动切换）。
         *
         * 为什么要人工确认：换中继要重建隧道、卡顿几秒，而玩家可能正在联机的关键时刻
         * （打 BOSS、比赛最后一把）。所以主控只把"有更空闲的中继可用"这条信息推出去，
         * 切不切由玩家自己决定 —— 客户端收到 `room.relayHint` 后复用消息通知那条链路
         * 弹提示（新版客户端还会响一声），房主点了才走 `reenterRoom()`。
         *
         * ⚠️ 单节点模型下**必须先房主**：真正的切换在房主拉票据那一刻生效，
         * 成员早点点「重连」也只会拿到旧中继（不会把自己弄丢，见 `#pendingRelay`）。
         *
         * 同时写一条房间系统消息：聊天记录里留痕，事后追溯"这个房间被换过中继"。
         */
        const targetName = candidate.row.name || candidate.row.id;
        const currentName = relayRow?.name ?? relayId;
        /**
         * 房间系统消息（聊天里留痕，也是老客户端唯一能看到的那份文本）。
         * **横幅上的文案由客户端按角色生成**（见 `client/src/lib/relay-hint.ts`）：
         * 房主那台该显示「立即切换」，成员那台该显示"需要房主更换" ——
         * 同一句话发下去两边都会别扭，所以事件里带上两台节点的名字（下面 push 的
         * `currentLabel` / `targetLabel`），文案交给知道"我是谁"的那一端拼。
         */
        const message =
          `平台提示：当前房间使用的中继节点「${currentName}」已经到容量上限，可能会出现卡顿。` +
          `可切换到新节点「${targetName}」—— 需要房主在房间页点「立即切换」，` +
          '其他成员等房主切完后点「重连」（各卡顿几秒）。请不要点「退出房间」，房主退出会关闭房间。';
        this.systemMessage(roomId, message);
        promoted.push({
          roomId,
          code: row.code,
          kind: 'switch',
          to: candidate.row.id,
          from: relayId,
          currentLabel: currentName,
          targetLabel: targetName,
          nodeUtil,
          rxBps: r.rx,
          txBps: r.tx,
          message,
        });
        continue;
      }

      // 回落：两条都降到阈值以下并且之前提升过 → 还原成原来的顺序（只在没人重进时悄悄发生）
      if (next <= -RELAY_SCALE_WINDOWS && busyNext <= -RELAY_NODE_BUSY_WINDOWS && this.#scaled.has(roomId)) {
        const state = this.#scaled.get(roomId)!;
        // 还没来得及搬（房主还没拉票据）就直接取消这次准备，别把房间搬走
        if (this.#pendingRelay.has(roomId)) {
          this.#pendingRelay.delete(roomId);
          log.info('房间中继负载回落，已取消准备好的切换', { room: roomId, code: row.code });
        } else {
          this.rooms.setRelayNodeIds(roomId, state.previous);
          log.info('房间中继已回到原顺序（流量回落）', { room: roomId, code: row.code });
        }
        this.#scaled.delete(roomId);
        this.#loadWindows.set(roomId, 0);
        this.#nodeWindows.set(roomId, 0);
      }
    }

    /**
     * **反向排查**：房间用的那台节点已经到线，但这一轮**没有任何节点上报在转发它** ——
     * 那条房间永远进不了上面的循环，于是"为什么节点 30% 了却不弹"永远查不到。
     * 这里补一条 info（同房间 10 分钟一次）：说明负载没算到这个房间头上
     * （常见于：成员都直连房主、房间其实没流量、或节点心跳里没有这个网络）。
     */
    const hotNodes = new Map<string, number>();
    for (const node of this.nodes.listSchedulable()) {
      const cap = node.capacity_bps ?? 0;
      const raw = cap > 0 ? Math.min(1, Math.max(node.rx_bps, node.tx_bps) / cap) : 0;
      const util = this.utilizationOf(node);
      if (nodeAtShedLine(util, raw, this.shedUtilOf(node))) hotNodes.set(node.id, Math.max(util, raw));
    }
    if (hotNodes.size > 0) {
      for (const room of this.rooms.listAll({ status: 'open', limit: 200 }).rows) {
        if (rate.has(room.id)) continue;
        const relayId = toRoom(room).relayNodeIds.find((id) => hotNodes.has(id));
        if (!relayId || !this.#diagAllowed(room.id, 'nosample')) continue;
        log.info('中继到线判定：房间的中继已到线，但没有任何节点上报在转发这个房间（流量没走中继？）', {
          room: room.id,
          code: room.code,
          node: this.nodes.findById(relayId)?.name ?? relayId,
          nodeUtil: Number((hotNodes.get(relayId) ?? 0).toFixed(3)),
        });
      }
    }
    return promoted;
  }

  /** 自动提升的状态（控制台房间详情显示"为什么这台排第一"） */
  relayScaleState(roomId: string): { at: string; rxBps: number; txBps: number } | null {
    const state = this.#scaled.get(roomId);
    if (!state) return null;
    return { at: new Date(state.at).toISOString(), rxBps: state.rxBps, txBps: state.txBps };
  }

  /** 这台节点的带宽利用率（0–1）；没配 capacity_bps 时恒为 0（不构成约束） */
  utilizationOf(row: NodeRow): number {
    return this.util.utilization(row.id, row.capacity_bps ?? 0);
  }

  /**
   * 这台节点自己的"不再接新房间"利用率阈值：小带宽节点更早卸荷（默认 80%）。
   * 口径与判定见 `node-utilization.ts` 的 `shedUtilFor`。
   */
  shedUtilOf(row: NodeRow): number {
    return shedUtilFor(row.capacity_bps, this.smallPipeThresholdBps(), this.settings.current.relaySmallShedPercent);
  }

  /** 带宽是否已到"不再分配新房间"的程度（与 NodeService 的状态机用同一个阈值） */
  isBandwidthBusy(row: NodeRow): boolean {
    return this.utilizationOf(row) >= this.shedUtilOf(row);
  }

  /* ------------------------------------------------------------ 内部 */

  /**
   * 暂存这轮 join 上报的延迟提示（空/缺失就不存）。顺手清掉过期的记录 ——
   * 只在 join 这条已经"要写库"的路径上做，成本可忽略，也不需要定时器。
   */
  #rememberHints(roomId: string, userId: string, hints: readonly RelayLatencyHint[] | null | undefined): void {
    if (!hints || hints.length === 0) return;
    const now = Date.now();
    for (const [key, value] of this.#joinHints) {
      if (now - value.at > RoomService.#HINTS_TTL_MS) this.#joinHints.delete(key);
    }
    this.#joinHints.set(`${roomId}:${userId}`, { hints: [...hints], at: now });
  }

  /** 取走暂存的提示（**取走即删**，只给首次分配用一次）；过期或没有则返回空数组 */
  #takeHints(roomId: string, userId: string): RelayLatencyHint[] {
    const key = `${roomId}:${userId}`;
    const found = this.#joinHints.get(key);
    if (!found) return [];
    this.#joinHints.delete(key);
    return Date.now() - found.at > RoomService.#HINTS_TTL_MS ? [] : found.hints;
  }

  /**
   * 把"准备好的新中继"落库（房主拉票据时调用）。返回是否真的换了。
   *
   * 三件事必须一起做：
   *   1. `room.relayNodeIds` 换成新的 —— 之后所有票据都拿新那台；
   *   2. **清掉所有成员的分配合**（`relay_node_id`）—— 否则成员下次拉票据时
   *      "分到的那台还在集合里吗"那一判断会失败重分，虽然也能修好，但会先发一张
   *      指向旧中继的票据（那一瞬间他是连不上的）；清掉更直接；
   *   3. 房间里写一条系统消息 —— 聊天里留痕，其他人看到就知道要重连（客户端还会响一声）。
   *
   * 节点已经不在了（被删/停用）就放弃这次切换并清掉待生效状态：宁可继续用旧的，
   * 也不能把整房搬到一个不存在的节点上。
   */
  #applyPendingRelay(roomId: string): boolean {
    const target = this.#pendingRelay.get(roomId);
    if (!target) return false;
    this.#pendingRelay.delete(roomId);
    if (!this.nodes.findById(target)) {
      log.warn('准备切换的中继节点已不存在，放弃这次切换', { room: roomId, node: target });
      return false;
    }
    const row = this.rooms.findById(roomId);
    if (!row || row.status !== 'open') return false;
    const previous = toRoom(row).relayNodeIds;
    if (previous.length === 1 && previous[0] === target) return false;
    this.rooms.setRelayNodeIds(roomId, [target]);
    this.rooms.clearMemberRelays(roomId);
    const name = this.nodes.findById(target)?.name ?? target;
    this.systemMessage(
      roomId,
      `房主已把中继切换到「${name}」。其他成员请点房间页上的提示重连一次（会卡顿几秒），` +
        '没重连的人暂时连不上房间。',
    );
    log.info('房间中继已切换（房主拉票据时生效）', { room: roomId, code: row.code, from: previous.join(','), to: target });
    notifyChanged(this.events, roomId);
    return true;
  }

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
