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
import { NodeUtilization } from './node-utilization.ts';

const log = logger('rooms');

/** 带宽利用率阈值：与 NodeService 的状态机保持一致（≥90% 不再分配新房间） */
const UTIL_SHED = 0.9;
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
 * 延迟并列带（ms）：**在权重（且余量）相同的前提下**，实测延迟落在同一段区间内的候选
 * 就算「同一档」，交回「空余带宽 → relayScore」决胜（谁更空、有没有降级）。
 *
 * 为什么是 5ms（本轮从 20ms 收紧）：客户端的 tcping 是**3 次 TCP 握手取最快**，
 * 同城/同网节点上重复测量的抖动本来就小（取最快之后典型只有 1–3ms），
 * **同档容差 5ms** 已经足够盖住这点测量噪声；而档内的胜负本轮已经交给"空余带宽"
 * （见 selectRelays 的键 ③），所以带子不需要、也不该再宽到 20ms ——
 * 那样会把"确实差了一截（10-20ms）"的节点也算成并列，让更空的远节点抢走本该更近的那台。
 * 反过来，落在 5ms 之内的几毫秒差异不值得纠结：那点差别是噪声，而"一台快满、一台很空"是事实。
 * 这条带子也吞不掉跨区域的真实差距（华东↔华南/华北 30–60ms、出境 100ms 起）：
 * 权重相同时它们照样按延迟排队。
 *
 * ⚠️ 语义是**区间极差**，不是两两比较：同一档 = 一段连续区间，
 * 区间内 `(最大 ms − 最小 ms) ≤ 本带子`。用户的原话是"取各个节点的差值，差值不超过 5ms
 * 才算同一档"，但那**不满足传递性**（0/4/8：0↔4 ✓、4↔8 ✓、0↔8 ✗），
 * 拿它当排序依据会让结果依赖引擎的比较次数（同样的输入可能排出不同结果）。
 * 用区间极差实现则稳定、可复现，而且语义更严格：
 * 一档里最远的两台相差也不超过 5ms，任意两台自然都在带内。
 *
 * ⚠️ 生效范围（「权重优先」改造的重点）：并列带**只在权重相同、且两者都真有余量时才生效**。
 * 权重不同一律由权重说了算 —— 高权重节点哪怕慢 90ms 也照样赢，因为权重是运营方的
 * 定价/意愿表达，而延迟只是同一档位内部的体感微调。
 */
export const LATENCY_TIE_BAND_MS = 5;

/** 调度候选：节点行 + 该节点当前的带宽利用率（由调用方采样传入，好让下面的选择函数保持纯） */
export interface RelayCandidate {
  row: NodeRow;
  /** 带宽利用率 0–1；≥ UTIL_SHED 表示这一轮不再接新房间 */
  utilization: number;
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
  return candidate.row.peers < candidate.row.capacity_peers && candidate.utilization < UTIL_SHED;
}

/** 参与排序的候选：把排序键预先算好，免得比较器里反复查表 */
interface RankedCandidate {
  candidate: RelayCandidate;
  /** 键 0：真有余量（还能接新房间） */
  headroom: boolean;
  /** 键 ①：运营方权重 */
  weight: number;
  /** 键 ②：实测延迟 ms；`+∞` = 没有提示（延迟未知，不优待） */
  ms: number;
  /** 键 ③（只在延迟并列带内比）：空余带宽 `1 − utilization`，越大越优先 */
  bwFree: number;
}

/**
 * 从候选池里挑中继节点（纯函数，便于单测）：**权重优先，权重相同才比延迟**。
 *
 * 排序键（依次比较，前一条能分出胜负就不看后面）：
 *   0. **真有余量**（`hasHeadroom`）的排前面 —— 硬条件的延伸，不是偏好（理由见该函数注释）。
 *      真的一个有余量的候选都没有时（`scheduleRelays` 的带宽回退分支），它们之间照旧按 ①–⑤ 排。
 *   ① `weight` 降序 —— **主键**
 *   ② 权重相同才比延迟：有提示且真有余量的按 ms 升序；没有提示的排在后面
 *      （没提示 = 延迟未知，不优待；沿用改造前"有提示的排在没提示的之前"的相对关系）
 *   ③ **延迟落在并列带内（区间极差 ≤ `LATENCY_TIE_BAND_MS`）时，先比空余带宽**
 *      `1 − utilization` 降序 —— "延迟在 5ms 之内就别纠结那几毫秒，挑带宽最空的"。
 *      `utilization` 是调用方采样好传进来的（见 `RelayCandidate`），这里不重新采一次。
 *   ④ 仍相同 → `relayScore` 降序（= weight × min(人数余量, 带宽余量) − 降级罚分；
 *      权重在这一步已经相等，所以它实际比的是"哪台更空、有没有降级"）
 *   ⑤ 仍相同 → `peers` 升序（改造前就有的收尾判据，保证同分结果稳定）
 *
 * "主中继 + 兜底中继"就是**一次取前两名**：同一个函数、同一套规则、同一份候选池，
 * 只是 `max = 2`（见 `RoomService.create`）。所以兜底不是"另一套降级规则"，
 * 而是"这套规则下的第二名"；两个名次天然不重复（同一个节点在候选池里只出现一次）。
 * 每次票据请求都重新算一遍（`utilization` 也是实时采样），于是"这台满了就先挑另一台"
 * 会在下一张票据里自动生效 —— 不需要任何"浮动切换"状态机。
 *
 * 为什么权重是主键、延迟只是次键（用户拍板的语义）：
 *   · `weight` 是运营方在控制台里写下的**意图**（专线/贵节点调高、临时顶不住的调低），
 *     它必须能压过"几毫秒的体感差异"，否则权重就形同虚设；
 *   · 延迟只用来在**同一档位**里挑更近的那台，这正是"权重一致时比延迟"的含义。
 *   反过来的"延迟优先"会让一台运营方并不想用的节点仅凭几毫秒优势抢走流量。
 *
 * 硬条件一条都不放松：候选池由调用方按状态/禁用/权重/带宽/区域筛好，本函数既不放松也不新增 ——
 * 提示里出现池外节点（被停用、权重 0、离线、别区域…）时那条提示自然无效，
 * 拼接过的 nodeId 也拉不进任何东西。
 *
 * ⚠️ **老客户端（不发 `latencyHints`）的选择结果也会变**：改造前是纯 `relayScore` 排序
 * （weight 只是打分里的一个因子），现在是"权重 → 打分"。于是"权重更低但更空的节点"
 * 不再能越过权重更高的节点。例：权重 100、已用 400/500 人（打分 20）的节点，
 * 以前输给权重 90、几乎全空（打分 89.1）的节点，现在它赢。
 * 这是用户明确要的语义（权重说了算），不是副作用；权重相同时行为与改造前逐位一致。
 */
export function selectRelays(
  candidates: readonly RelayCandidate[],
  hints: readonly RelayLatencyHint[] | null | undefined,
  max: number,
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
   * 键 ③④：**档内决胜** —— 先比空余带宽降序，再回到 byScore。
   *
   * 为什么带宽在档内排第一：延迟已经落进 5ms 的并列带（`LATENCY_TIE_BAND_MS`），
   * 那几毫秒是测量噪声级别的差别，不值得纠结；而"这台还剩多少带宽"是实打实的事实
   * —— 同样是 12ms 的两台，一台用掉 8 成、一台空着，当然挑空的那台。
   * 注意这里**只**比带宽余量：人数余量与降级罚分留给 byScore，口径不重复。
   */
  const byBand = (a: RankedCandidate, b: RankedCandidate): number =>
    b.bwFree - a.bwFree || byScore(a.candidate, b.candidate);
  /** 提示只在"真的还能接新房间"的节点上算数（见 hasHeadroom） */
  const hintedMs = (candidate: RelayCandidate): number | undefined =>
    hasHeadroom(candidate) ? hintMs.get(candidate.row.id) : undefined;

  const ranked: RankedCandidate[] = candidates.map((candidate) => ({
    candidate,
    headroom: hasHeadroom(candidate),
    weight: candidate.row.weight,
    ms: hintedMs(candidate) ?? Number.POSITIVE_INFINITY,
    bwFree: freeBandwidth(candidate.utilization),
  }));

  /**
   * 第一趟：键 0 → ① → ②（+ 一个稳定的收尾键）。
   *
   * 这一趟只负责把**档序**排出来：同权重、同余量的节点按 ms 升序，好让第二趟切"连续区间"。
   * 收尾键仍是老的 `byScore`，所以**没上报延迟的那一队（ms = +∞）内部顺序与改造前逐位一致**
   * （它们不参与档内决胜）；有提示的档会在第二趟被 byBand 重排，这里排成什么不影响结果。
   * sort 是稳定的：完全并列的候选保持调用方给的顺序（`listSchedulable` 本来就是 weight desc）。
   */
  ranked.sort(
    (a, b) =>
      Number(b.headroom) - Number(a.headroom) ||
      b.weight - a.weight ||
      // 两边都没提示时 `+∞ - +∞ = NaN`，而 NaN 在比较器里的行为是实现定义的 → 显式判等
      (a.ms === b.ms ? 0 : a.ms - b.ms) ||
      byScore(a.candidate, b.candidate),
  );

  /**
   * 第二趟：只在**键 0 与权重都相同**的连续区间内做"延迟并列带"。
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
    // 切出「同余量 + 同权重」的连续区间：跨区间的胜负在第一趟就已经定了，延迟不参与
    let stop = start + 1;
    while (stop < ranked.length) {
      const next = ranked[stop];
      if (!next || next.headroom !== head.headroom || next.weight !== head.weight) break;
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
 * 房间中继"过载"的判定窗口数（30 秒一轮 → 6 轮 ≈ 3 分钟）。
 *
 * 为什么不是一次就动：房间刚建好、玩家在下载资源包、有人刚进服，都会让瞬时速率冲高，
 * 单窗口触发等于把抖动当成长时间过载。3 分钟也够一个"真的在跑大流量"的房间暴露出来。
 * 回落用同一个窗口数（防抖，别来回切）。
 */
export const RELAY_SCALE_WINDOWS = 6;

/**
 * 这一台是否属于「大带宽档」。
 *
 * 门槛是平台设置里的 `relayBigPipeBps`（默认 10 Mbps）；**`capacity_bps = 0`
 * （控制台里没填带宽上限）也算大档** —— 那个字段在界面上就是"不限"，
 * 把它当成小管子会让默认部署（没人填容量）全部落到"没有大档节点"。
 */
export function isBigPipeNode(row: NodeRow, thresholdBps: number): boolean {
  const capacity = row.capacity_bps ?? 0;
  if (capacity === 0) return true;
  return thresholdBps <= 0 || capacity >= thresholdBps;
}

/**
 * 中继槽（真正承载数据的那台）：**大带宽档 → 客户端实测延迟优先**。
 *
 * 与 `selectRelays` 的区别只有一个：主键换成延迟而不是权重（用户要求"兜底（= 中继）节点
 * 也要按延迟优先"）。其余判据沿用同一套：真有余量的优先 → 延迟升序 → 权重降序 →
 * 空余带宽 → relayScore → peers。没有延迟提示的节点排在最后（与 `selectRelays` 一致）。
 *
 * 延迟用的是**建房那个客户端上报的 tcping**（`latencyHints`）：它测的正是
 * "这台机器到我这条链路"，而中继槽就是给这个房间的人用的。
 *
 * 模块级函数（不是类私有方法）是为了让单测能用假对象直接钉住这套排序
 * —— 见 `test/unit.test.ts` 的 `schedule()`。
 */
export function pickRelayNode(
  pool: readonly RelayCandidate[],
  latencyHints: readonly RelayLatencyHint[],
  excludeId: string,
  thresholdBps: number,
  zone = '',
): NodeRow | null {
  const rest = pool.filter((c) => c.row.id !== excludeId);
  if (rest.length === 0) return null;
  const big = rest.filter((c) => isBigPipeNode(c.row, thresholdBps));
  if (big.length === 0) {
    log.warn('没有大带宽档的中继节点，中继槽只能从全部候选里按延迟挑（见设置「大带宽档门槛」）', {
      zone,
      candidates: rest.length,
    });
  }
  const candidates = big.length > 0 ? big : rest;

  const hintMs = new Map<string, number>();
  for (const hint of latencyHints) {
    if (!hint || typeof hint.nodeId !== 'string') continue;
    if (typeof hint.ms !== 'number' || !Number.isFinite(hint.ms) || hint.ms < 0) continue;
    const prev = hintMs.get(hint.nodeId);
    if (prev === undefined || hint.ms < prev) hintMs.set(hint.nodeId, hint.ms);
  }
  const ranked = candidates.map((c) => ({
    candidate: c,
    headroom: hasHeadroom(c),
    ms: (hasHeadroom(c) ? hintMs.get(c.row.id) : undefined) ?? Number.POSITIVE_INFINITY,
    bwFree: freeBandwidth(c.utilization),
    score: relayScore(c.row, c.utilization),
  }));
  ranked.sort(
    (a, b) =>
      Number(b.headroom) - Number(a.headroom) ||
      (a.ms === b.ms ? 0 : a.ms - b.ms) ||
      b.candidate.row.weight - a.candidate.row.weight ||
      b.bwFree - a.bwFree ||
      b.score - a.score ||
      a.candidate.row.peers - b.candidate.row.peers,
  );
  return ranked[0]?.candidate.row ?? null;
}

/**
 * 取中继：**槽 1 = 打洞节点，槽 2 = 中继节点**（用户 2026-09-28 拍板的模型）。
 *
 * 为什么要分角色：部分节点的带宽确实少，但它们在网络里并非没用 ——
 * EasyTier 的 P2P 打洞需要一个双方都能连上的公共 peer 来交换公网地址。
 * 把这类节点标成「只协助打洞」（`assist_only`，生成配置时写 `disable_relay_data`）后：
 *   · 槽 1 放它：负责协调打洞，**不承载数据**（OSPF 会给它的中继链路极大代价）；
 *   · 槽 2 放大管子：因为槽 1 转不了数据，"客户端走中继时用哪台"就由结构决定，
 *     不需要客户端配合 —— 这正是我们要的确定性。
 *
 * 三条硬纪律：
 *   · 没有标 assist 的节点时，槽 1 退回原规则（等价于旧的"主中继"），行为向后兼容；
 *   · **打洞节点永远不会被放进槽 2** —— 它不承载数据，放进去等于这个房间没有中继；
 *   · 没有大带宽档时槽 2 退回全部候选并记 warn，绝不为了满足约束而少给一台中继。
 *
 * 跨区域调中继（用户 2026-09-28 追加）：区域仍然是硬条件，但**本区域一个能承载数据的
 * 节点都没有**（全是"只协助打洞"）时，槽 2 从**全局池**里挑一台（延迟优先 —— 跨区时
 * 它自然就挑最近的那个外区节点），并记一条 warn。槽 1（打洞）仍然留在本区域：
 * 打洞节点要和玩家近，"帮打洞"这件事跨区没有意义。
 */
export function pickRoomRelays(
  zonePool: readonly RelayCandidate[],
  allPool: readonly RelayCandidate[],
  latencyHints: readonly RelayLatencyHint[],
  max: number,
  thresholdBps: number,
  zone = '',
): string[] {
  if (max <= 0 || zonePool.length === 0) return [];
  if (max === 1) return selectRelays(zonePool, latencyHints, 1).map((n) => n.id);

  // 槽 1：优先从「只协助打洞」的节点里挑（同一套排序：权重 → 延迟 → 空余带宽）
  const assist = zonePool.filter((c) => c.row.assist_only === 1);
  const punch = selectRelays(assist.length > 0 ? assist : zonePool, latencyHints, 1)[0];
  if (!punch) return [];

  /**
   * 槽 2 的候选必须是**能承载数据的节点**（排除打洞节点）。
   * 本区域一台都没有时跨区调 —— 这是"某个区域只有打洞节点"的唯一解法；
   * 否则该区域建出来的房间只有一条打洞路径，实际没有中继可用。
   */
  const local = zonePool.filter((c) => c.row.assist_only !== 1);
  const crossed = local.length === 0;
  const candidates = crossed ? allPool.filter((c) => c.row.assist_only !== 1) : local;
  if (candidates.length === 0) return [punch.id];
  if (crossed) {
    log.warn('本区域没有可承载数据的中继节点（只有打洞节点），已从其它区域调一台', {
      zone,
      candidates: candidates.length,
    });
  }

  // 槽 2：大带宽档 + 客户端实测延迟优先
  const relay = pickRelayNode(candidates, latencyHints, punch.id, thresholdBps, zone);
  return relay ? [punch.id, relay.id] : [punch.id];
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
  readonly #scaled = new Map<string, { previous: string[]; rxBps: number; txBps: number; at: number }>();

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
     * 中继节点：用户指定优先，**平台再补一个兜底**，且与已选的不重复。
     *
     * 自动模式（没有手选）固定下发 **2 个不同节点**：`selectRelays` 的**第一顺位 = 主中继**、
     * **第二顺位 = 兜底中继** —— 两个名次来自**同一套规则**（权重 → 5ms 并列带 → 空余带宽 → 打分，
     * 见 `selectRelays`），只是一次取两个。所以"兜底"不是另一套降级规则，而是这套规则下的第二名；
     * 同一个节点在候选池里只出现一次，两名天然不重复。
     *
     * 手选模式：手选节点照旧原样优先（`#validatePickedNodes` 只看硬条件、不看延迟），
     * 兜底从调度结果里挑第一个**没被手选**的，避免重复占名额。
     *
     * `latencyHints` 只喂给自动调度：自动模式下它就是"在同权重、延迟又要并列的候选里选谁"，
     * 手动模式下它只决定"先挑哪台当兜底"。
     *
     * ⚠️ **浮动切换是天然的，不需要状态机**：票据每次请求都现算，`utilization` 也是实时采样
     * （见 `scheduleRelays`），所以"这台满了 → 下次先挑另一台"会在**下一张票据**里自动生效。
     * 已经进了房间的玩家**不会**因为这次切换被踢：他们的 peer 列表来自加入时那张票据，
     * 只有重连/重进（重新拉票据）才会拿到新的中继排序。
     */
    const picked = this.#validatePickedNodes(input.nodeIds ?? []);
    const auto = this.scheduleRelays(zone, input.latencyHints ?? [], 2);
    /** 平台补的那一个兜底：自动模式 = 第二顺位；手动模式 = 调度结果里第一个没被手选的 */
    const fallback =
      picked.ids.length > 0 ? (auto.find((id) => !picked.ids.includes(id)) ?? null) : (auto[1] ?? null);
    const relayNodeIds = picked.ids.length > 0 ? [...picked.ids, ...(fallback ? [fallback] : [])] : auto;
    const nodeSelection = {
      requested: input.nodeIds ?? [],
      accepted: picked.ids,
      rejected: picked.rejected,
      fallback,
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
    return {
      // 待审批时连房间对象也不能带网络名，否则「审批」这道门形同虚设
      room: toRoomForUser(fresh, input.userId),
      member: toMember(member),
      ticket: pending
        ? null
        : this.ticket(
            row.id,
            input.userId,
            input.listenPort ?? this.settings.current.relayPort,
        input.rpcPort,
          ),
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
  ): RoomTicket {
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
    const isHost = room.hostUserId === userId;

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
  ): { kicked: boolean; aclToml: string | null; aclRevision: number } {
    const member = this.rooms.findMember(roomId, userId);
    if (!member) return { kicked: true, aclToml: null, aclRevision: 0 };
    if (member.status === 'kicked') {
      return { kicked: true, aclToml: null, aclRevision: 0 };
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
    };
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
   * `max = 2` 时返回的就是「主中继 + 兜底中继」两个**不同**节点（一次取前两名）。
   *
   * `latencyHints` 缺省（老客户端 / 改区域触发的重调度）＝ 权重优先、同权重再按 relayScore；
   * 注意这**不再**等于改造前的纯 relayScore 排序（权重成了第一判据，见 `selectRelays`）。
   * 指定区域时该区域无可用节点仍回退到全局（并记日志），
   * 避免玩家因为某个区域没部署节点而完全无法联机。
   *
   * ⚠️ 这里**不缓存**任何"谁被选中"的状态：每次调用都重新采样 `utilization` 并重新排序，
   * 所以"某台满了就换一台"是天然的浮动切换（下一张票据自动生效），不需要状态机。
   */
  scheduleRelays(zone: string, latencyHints: readonly RelayLatencyHint[] = [], max = 2): string[] {
    const all = this.nodes.listSchedulable();
    if (all.length === 0) return [];
    /**
     * 带宽利用率在这里采样一次，筛选与打分共用同一个值。
     * 两次调用会各读一次 EWMA —— 同一 tick 内结果相同，但写死"用的就是这一次采样"
     * 更不容易在以后加入 await 时出现"按 A 判定还有富余、按 B 打分"的错位。
     * 档内决胜（键 ③）用的也是这**同一个**值，不另采一次。
     */
    const candidates: RelayCandidate[] = all.map((row) => ({ row, utilization: this.utilizationOf(row) }));

    /**
     * 带宽已吃紧（利用率 ≥90%）的节点**这次不再分配新房间**。
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

  /** 大带宽档门槛（字节/秒），见模块级 `isBigPipeNode` */
  bigPipeThresholdBps(): number {
    return Math.max(0, this.settings.current.relayBigPipeBps);
  }

  /** 见模块级 `isBigPipeNode` */
  isBigPipe(row: NodeRow): boolean {
    return isBigPipeNode(row, this.bigPipeThresholdBps());
  }

  /**
   * 取中继：转发给模块级 `pickRoomRelays`（那里是纯函数，便于单测钉规则）。
   * 这里只负责把平台设置里的门槛读出来。
   */
  pickRelays(
    zonePool: readonly RelayCandidate[],
    allPool: readonly RelayCandidate[],
    latencyHints: readonly RelayLatencyHint[],
    max: number,
    zone: string,
  ): string[] {
    return pickRoomRelays(zonePool, allPool, latencyHints, max, this.bigPipeThresholdBps(), zone);
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
  ): Array<{ roomId: string; code: string; to: string; from: string; rxBps: number; txBps: number; message: string }> {
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
      to: string;
      from: string;
      rxBps: number;
      txBps: number;
      /** 给玩家的建议文案（客户端复用消息通知弹出来，切不切由玩家决定） */
      message: string;
    }> = [];
    for (const [roomId, r] of rate) {
      const total = r.rx + r.tx;
      const over = total >= threshold;
      // 有符号窗口计数：正 = 持续超载，负 = 持续空闲
      const windows = this.#loadWindows.get(roomId) ?? 0;
      const next = over ? Math.max(windows, 0) + 1 : Math.min(windows, 0) - 1;
      this.#loadWindows.set(roomId, next);

      const row = this.rooms.findById(roomId);
      if (!row || row.status !== 'open') continue;
      const current = toRoom(row).relayNodeIds;

      if (next >= RELAY_SCALE_WINDOWS && !this.#scaled.has(roomId)) {
        const [punchId, relayId] = current;
        if (!punchId || !relayId) continue;
        /**
         * 换的是**槽 2（中继节点）**，槽 1（打洞节点）不动 —— 这是新模型下的正确动作：
         * 打洞节点本来就不承载数据，把它换掉没有意义；要缓解过载只能换那台真正在转发的。
         * 只在"确实存在更空的大管子"时才换，避免为了动作而动作。
         */
        const currentRelay = this.nodes.findById(relayId);
        const currentFree = currentRelay ? freeBandwidth(this.utilizationOf(currentRelay)) : -1;
        const candidate = this.nodes
          .listSchedulable()
          .map((row) => ({ row, utilization: this.utilizationOf(row) }))
          .filter(
            (c) =>
              c.row.id !== punchId &&
              c.row.id !== relayId &&
              this.isBigPipe(c.row) &&
              !this.isBandwidthBusy(c.row),
          )
          .sort((a, b) => freeBandwidth(b.utilization) - freeBandwidth(a.utilization) || b.row.weight - a.row.weight)[0];
        if (!candidate) {
          log.warn('房间中继过载，但没有更空的大带宽节点可换（见设置「大带宽档门槛」）', { room: roomId, code: row.code });
          continue;
        }
        if (freeBandwidth(candidate.utilization) <= currentFree) {
          log.warn('房间中继过载，但当前中继已是最空的大带宽节点', { room: roomId, code: row.code });
          continue;
        }
        this.rooms.setRelayNodeIds(roomId, [punchId, candidate.row.id]);
        this.#scaled.set(roomId, { previous: current, rxBps: r.rx, txBps: r.tx, at: now });
        this.#loadWindows.set(roomId, 0);
        /**
         * 给玩家一条**建议**（不是自动切换）。
         *
         * 为什么要人工确认：换中继要重建隧道、卡顿几秒，而玩家可能正在联机的关键时刻
         * （打 BOSS、比赛最后一把）。所以主控只把"有更空闲的中继可用"这条信息推出去，
         * 切不切由玩家自己决定 —— 客户端收到 `room.relayHint` 后复用消息通知那条链路
         * 弹提示，玩家点了才走 `reenterRoom()`（那条路径不调 leave，房主也不会关房）。
         *
         * 同时写一条房间系统消息：聊天记录里留痕，事后追溯"这个房间被换过中继"。
         */
        const message =
          '平台提示：这个房间的中继有点挤，已经为你准备了更空闲的中继。' +
          '想切换的话回到首页在「最近进入」里点一下这个房间（会卡顿几秒）；' +
          '请不要点「退出房间」—— 房主退出会关闭房间。不切换也不影响继续联机。';
        this.systemMessage(roomId, message);
        promoted.push({
          roomId,
          code: row.code,
          to: candidate.row.id,
          from: relayId,
          rxBps: r.rx,
          txBps: r.tx,
          message,
        });
        continue;
      }

      // 回落：降到阈值以下并且之前提升过 → 还原成原来的顺序（只在没人重进时悄悄发生）
      if (next <= -RELAY_SCALE_WINDOWS && this.#scaled.has(roomId)) {
        const state = this.#scaled.get(roomId)!;
        this.rooms.setRelayNodeIds(roomId, state.previous);
        this.#scaled.delete(roomId);
        this.#loadWindows.set(roomId, 0);
        log.info('房间中继已回到原顺序（流量回落）', { room: roomId, code: row.code });
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

  /** 带宽是否已到"不再分配新房间"的程度（与 NodeService 的状态机用同一个阈值） */
  isBandwidthBusy(row: NodeRow): boolean {
    return this.utilizationOf(row) >= UTIL_SHED;
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
