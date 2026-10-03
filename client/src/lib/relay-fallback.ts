/**
 * 「到房主的链路质量差 → 回落中继」的判据、票据改写与本机偏好。
 *
 * 为什么需要它：打洞成功不等于链路可用。到房主那条直连走的是两个玩家各自的家宽，
 * 中间任何一跳拥塞都会表现为**丢包**——延迟看着还行（20ms），但游戏里人物会回弹。
 * 这种时候绕一次中继反而更稳。EasyTier 自己一直在算丢包（`loss_rate`，
 * 最近 100 次探测的滑动窗口），`peer list` 里就有这一列，我们只需要读出来 + 决定要不要绕。
 *
 * ⚠️ 判据的**对象**在这一版被纠正过（用户实测指出）：
 * `cost = p2p` 只表示"**本机到那个节点**之间是直连"，**不是**"玩家之间的 P2P"——
 * 我们到平台下发的中继节点本来就常常是直连。上一版按 `cost = p2p` 取最大值，
 * 于是"到中继服务器的直连"被当成了"玩家间的直连"：房间里四条连接全是中继节点，
 * 却弹出「P2P 直连在丢包（最高 8.0%）」，而 8% 那条正是 `PublicServer_relay-sh`。
 * 现在只认一条链路：**本机 → 房主**（房主跑着游戏服务端，它才决定游戏手感）。
 *
 * 这个文件只放**纯函数与偏好读写**（可以在没有 Electron、没有网络的情况下离线校验，
 * 见 client/scripts/verify-relay-fallback.mjs）。真正跑时钟、重启核心的状态机在
 * lib/store.ts 里 —— 那里才拿得到 session 与 IPC。
 */
import type { PeerView } from './easytier-parse.ts';
import { linkKind } from './easytier-parse.ts';

/* ====================================================================== 阈值
 *
 * 下面每一档都写清了"为什么是这个数"。改动前先想清楚：这些数字直接决定
 * 「玩家的网络会被断几秒、断几次」，不是调参口味问题。
 */

/** 丢包判据：5%。用户给的线，也正好是实时游戏开始能感觉到的量级。 */
export const LOSS_THRESHOLD = 0.05;

/**
 * 采样窗口 12 秒。
 *
 * 现有心跳每 10 秒拉一次 `peer list`（store.ts 的 sendHeartbeat → pollPeers），
 * 取 12 秒是为了每两次采样之间**至少**跨过一次真实刷新，又不与心跳同拍
 * （同拍就会反复读到同一份数据，连续 N 次采样变成一次）。
 *
 * 注意 EasyTier 的 loss_rate 本身是「最近 100 次探测」的滑动窗口（约 100 秒），
 * 所以相邻采样是高度重叠的 —— 这恰恰是"必须连续 N 个窗口"的原因：
 * 单次采样说明不了任何事，只有它**持续**为高才叫劣化。
 */
export const SAMPLE_WINDOW_MS = 12_000;

/**
 * 连续 3 个窗口（≈36 秒）都超标才动作。
 *
 * 为什么不取 1：游戏加载、房间刚建好、对端在下载东西，都会让 100 次探测的窗口
 * 短暂冲过 5%，单窗口触发等于把瞬时抖动当成长期劣化，白断一次。
 * 为什么不取 10：36 秒已经能滤掉瞬时抖动；再长玩家就要先忍受一分多钟的回弹。
 */
export const TRIGGER_WINDOWS = 3;

/**
 * A/B 观察期：切到中继后先等 20 秒再判"中继是不是更差"。
 *
 * 这笔时间必须留够：重启核心 ≈3~5 秒建隧道，之后 EasyTier 才有探测样本，
 * 而它的丢包窗口是 100 次探测 —— 立刻比较只会读到一堆还没测出来的空值。
 * 20 秒 = 建隧道 + 一个完整采样窗口的下限。
 */
export const AB_OBSERVE_MS = 20_000;

/**
 * 中继侧自己也丢 ≥2% → 判定"问题不在到房主那段直连"。
 * （中继在丢，说明丢包发生在更靠上游或对端那侧，换路解决不了。）
 */
export const AB_RELAY_LOSS_TOLERANCE = 0.02;

/**
 * 中继延迟判据：比 P2P 基线高 60% **且**绝对差 ≥30ms 才算绕远。
 *
 * 为什么要同时卡绝对差：P2P 基线只有 5ms 时，×1.6 才 8ms —— 纯比例会把
 * "同城中继多 3 毫秒"判成更差，于是自动回落永远被立刻回退，等于这个功能不存在。
 */
export const AB_LATENCY_RATIO = 1.6;
export const AB_LATENCY_ABS_MS = 30;

/**
 * A/B 判定"中继更差"之后的冷却：30 分钟内不再自动降级。
 *
 * 出现这种情况说明**判据本身在这条链路上不可信**（可能是中继拥塞，也可能是对端问题），
 * 短时间内重试只会把同一次断流重演一遍。冷却到期后重新开始观察，
 * 期间玩家仍然可以自己手动切（手动开关不受冷却限制）。
 */
export const AB_REVERT_COOLDOWN_MS = 30 * 60_000;

/**
 * 降级后的 P2P 重试：首次 15 分钟，之后每次失败翻倍，1 小时封顶。
 *
 * 为什么基准是 15 分钟：一次重试要重启核心（约 3~5 秒断流），
 * 15 分钟一次 = 每小时 4 次 × 4 秒 ≈ 每小时 16 秒，占比 0.4%，玩家基本察觉不到。
 * 为什么封顶 1 小时：劣化持续一小时以上多半是长期线路问题，
 * 再每小时打断 4 次只是反复伤害体验。
 */
export const PROBE_BASE_MS = 15 * 60_000;
export const PROBE_MAX_MS = 60 * 60_000;
export const PROBE_FACTOR = 2;

/* =================================================== 票据 TOML：注入 disable_p2p */

/** `[flags]` 段头（允许行尾注释与缩进） */
const FLAGS_HEADER_RE = /^\s*\[flags\]\s*(?:#.*)?$/;
/** 任意段头：用来界定 `[flags]` 段的结束 */
const ANY_HEADER_RE = /^\s*\[/;
const DISABLE_P2P_RE = /^\s*disable_p2p\s*=/;

/**
 * 把 `disable_p2p = true` 注入主控下发的票据 TOML。
 *
 * 为什么是"注入"而不是"改"：
 *  · 主控给每张票据都会写一行 `disable_p2p = false`（server/src/services/rooms.ts），
 *    所以正常情况下我们只是**翻转**这一个布尔值；
 *  · 中继/成员两种票据、以及房主把「允许 P2P 直连」关掉时的票据，
 *    这一段的位置与内容都可能不同（甚至可能没有 `[flags]` 段），所以三种情况都要兜住；
 *  · **关闭只走同一个入口的"不注入"**（用原始票据），从不做"删掉这一行"的反向编辑 ——
 *    删除会连带把房主设的 `disable_p2p = true` 一起删掉，等于绕过房间规则。
 *
 * 找不到 `[flags]` 段时**追加到文件末尾**：TOML 里表头之后的所有裸键都属于它，
 * 追加在最后不会把前面 `[acl...]`、`[file_logger]` 里的键抢过来。
 */
export function withDisableP2p(toml: string): string {
  const lines = toml.split('\n');
  const start = lines.findIndex((line) => FLAGS_HEADER_RE.test(line));

  if (start < 0) {
    const body = toml.endsWith('\n') ? toml : `${toml}\n`;
    return `${body}\n[flags]\ndisable_p2p = true\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (ANY_HEADER_RE.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }

  for (let i = start + 1; i < end; i += 1) {
    if (DISABLE_P2P_RE.test(lines[i] ?? '')) {
      // 只换值，保留缩进：这一行可能是别人写的，形态越少动越好
      const indent = /^(\s*)/.exec(lines[i] ?? '')?.[1] ?? '';
      lines[i] = `${indent}disable_p2p = true`;
      return lines.join('\n');
    }
  }

  lines.splice(start + 1, 0, 'disable_p2p = true');
  return lines.join('\n');
}

/* =========================================== 票据 TOML：追加玩家自己的中继节点 */

/** `[[peer]]` 段头（数组表；票据里每台中继会写成两行 tcp/udp） */
const PEER_HEADER_RE = /^\s*\[\[peer\]\]\s*(?:#.*)?$/;
/** 段内 `uri = "..."` */
const PEER_URI_RE = /^\s*uri\s*=\s*["']([^"']+)["']/;

/**
 * 归一化玩家手填的一个节点地址。返回 `null` 表示这行不合法（界面会标红）。
 *
 * 接受的形态（宽松一点，玩家抄来的地址什么形状都有）：
 *   · `tcp://host:11010` / `udp://host:11010` / `ws://…` / `wss://…` —— 原样保留协议
 *   · `host:11010`            —— 同时给 tcp 与 udp 两条（EasyTier 两个都要）
 *   · `host`                  —— 用默认端口 11010
 *
 * 明确**拒绝**：带路径/查询串的（那是网页地址，不是节点）、端口越界、
 * 以及任何不是主机名/IP 的字符（避免把乱七八糟的东西写进内核配置）。
 */
export function normalizePeerUri(raw: string, defaultPort = 11010): string | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  const withScheme = /^(tcp|udp|ws|wss):\/\/(.+)$/i.exec(text);
  const scheme = withScheme ? withScheme[1]!.toLowerCase() : null;
  const rest = (withScheme ? withScheme[2]! : text).trim();
  if (rest.length === 0 || /[/?#]/.test(rest)) return null;

  const [hostPart, portPart, ...extra] = rest.split(':');
  if (extra.length > 0) return null;
  const host = (hostPart ?? '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(host)) return null;

  let port = defaultPort;
  if (portPart !== undefined && portPart !== '') {
    /**
     * ⚠️ 必须是**纯数字**：`Number.parseInt('11010；c.com')` 会返回 11010，
     * 于是 `b.com:11010；c.com` 这种"两个地址粘在一起、中间是全角分号"的输入
     * 会被悄悄截断成一条合法地址，后半截直接消失（离线校验里实测抓到）。
     */
    if (!/^\d+$/.test(portPart)) return null;
    const parsed = Number.parseInt(portPart, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
    port = parsed;
  }
  return `${scheme ?? 'tcp'}://${host}:${port}`;
}

/**
 * 把玩家自填的节点追加进票据 TOML（社区/自建中继，方便没有官方节点时也能联机）。
 *
 * 为什么插在**最后一个 `[[peer]]` 段之后**而不是文件末尾：TOML 里表头之后的所有裸键
 * 都属于那个表，追加到末尾虽然对新表也成立，但会和 `[acl…]`/`[file_logger]` 这些段混在一起，
 * 事后人看配置很难分辨"哪些 peer 是平台给的、哪些是我自己加的"。插在 peer 段尾部，
 * 两者相邻、一眼能对上；没有 peer 段时才退化成追加到末尾。
 *
 * 去重按**整行 URI**：同一个 `tcp://host:port` 平台已经给了就不再写一遍
 * （EasyTier 对重复 peer 只是白连一次，但配置里出现两遍会让人以为写错了）。
 * 非法地址**静默跳过**（界面在保存时就拦过一次，这里兜底不抛错 —— 一张坏地址
 * 不该让整个房间起不来）。
 */
export function withExtraPeers(toml: string, uris: readonly string[]): string {
  const wanted: string[] = [];
  for (const raw of uris) {
    for (const uri of splitPeerUris(raw)) {
      const parsed = normalizePeerUri(uri);
      if (parsed !== null && !wanted.includes(parsed)) wanted.push(parsed);
    }
  }
  if (wanted.length === 0) return toml;

  const existing = new Set<string>();
  for (const line of toml.split('\n')) {
    const m = PEER_URI_RE.exec(line);
    if (m?.[1]) existing.add(m[1].trim());
  }
  const fresh = wanted.filter((uri) => !existing.has(uri));
  if (fresh.length === 0) return toml;

  const block = fresh.map((uri) => `[[peer]]\nuri = "${uri}"`).join('\n');
  const body = toml.endsWith('\n') || toml.length === 0 ? toml : `${toml}\n`;
  const lines = body.split('\n');

  // 找最后一个 peer 段（含它自己的键行），插在它后面
  let lastPeerLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (PEER_HEADER_RE.test(lines[i] ?? '')) lastPeerLine = i;
  }
  if (lastPeerLine < 0) return `${body}${body.length > 0 ? '\n' : ''}${block}\n`;

  let insertAt = lastPeerLine + 1;
  while (insertAt < lines.length) {
    const line = lines[insertAt] ?? '';
    // 空行与注释仍算这一段的一部分；遇到下一个表头就停
    if (ANY_HEADER_RE.test(line)) break;
    insertAt += 1;
  }
  lines.splice(insertAt, 0, ...block.split('\n'));
  return lines.join('\n');
}

/**
 * 只按分隔符把一行拆成若干**原始 token**，不做任何协议展开。
 *
 * 为什么单独一层：界面要"把用户写错的那一段标红"，标红必须用**他写的原文**
 * （`tcp://https://…` 这种展开后的形态标出来只会让人更糊涂）。
 * `splitPeerUris` 在它之上做展开。
 */
export function splitPeerTokens(raw: string): string[] {
  // 分隔符要含**全角**的逗号/分号/顿号：玩家从中文论坛抄地址时经常是这些
  return raw
    .split(/[\s,;，；、]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * 把玩家填的一行拆成一个或多个地址。
 *
 * 界面允许一行一个、也允许逗号/空格/分号分隔（玩家习惯性会写成 `a, b`）；
 * `host:port` 这种没有协议的会被展开成 tcp + udp 两条 ——
 * EasyTier 的 peer 是单协议的，只填 tcp 时 UDP 打洞就没有引导节点可用。
 */
export function splitPeerUris(raw: string): string[] {
  const out: string[] = [];
  for (const part of splitPeerTokens(raw)) {
    if (/^(tcp|udp|ws|wss):\/\//i.test(part)) {
      out.push(part);
      continue;
    }
    // 没写协议：tcp 与 udp 各来一条（去重交给调用方）
    out.push(`tcp://${part}`, `udp://${part}`);
  }
  return out;
}

/* ================================================================== 采样与判据 */

/** 一个节点在某一时刻的最佳路径读数（A/B 对照用的基线就是它） */
export interface RouteSample {
  /** 虚拟地址（拿不到时退回主机名）—— A/B 对照靠它把"同一个人的前后两条路"对上 */
  key: string;
  cost: string;
  lossRate: number | null;
  latencyMs: number | null;
}

/** 同一节点可能同时有 p2p 与 relay 两条记录，取"更该被相信"的那条：直连优先，其次延迟低 */
function routeScore(peer: PeerView): number {
  return (linkKind(peer.cost) === 'p2p' ? 0 : 10_000) + (peer.latencyMs ?? 5_000);
}

/** 按节点归并 `peer list`：每个虚拟地址只留一条最佳路径 */
export function bestRoutes(peers: readonly PeerView[]): RouteSample[] {
  const best = new Map<string, PeerView>();
  for (const peer of peers) {
    if (linkKind(peer.cost) === 'local') continue;
    const key = peer.ipv4 || peer.hostname;
    if (key.length === 0) continue;
    const prev = best.get(key);
    if (!prev || routeScore(peer) < routeScore(prev)) best.set(key, peer);
  }
  return [...best.entries()].map(([key, peer]) => ({
    key,
    cost: peer.cost,
    lossRate: peer.lossRate,
    latencyMs: peer.latencyMs,
  }));
}

/** 虚拟地址可能带 /24 掩码（本机那一行就是），比较前统一剥掉 */
function bareIp(value: string | null | undefined): string {
  return (value ?? '').split('/')[0] ?? '';
}

/**
 * 「本机 → 房主」那一条链路 —— **丢包判定唯一的对象**。
 *
 * 为什么必须是它，而不是"所有 cost = p2p 的节点里最差的那条"：
 *   · cost = p2p 只说明**本机到那个节点**是直连，平台中继节点通常也是直连的，
 *     把它们算进来就会出现"全是中继节点却在报 P2P 丢包"这种自相矛盾的提示；
 *   · 玩家感知到的卡顿只来自**跑着游戏服务端的那台机器**（房主），
 *     其它成员/中继节点的丢包是它们自己的质量，不该替玩家下结论。
 *
 * 归并口径与界面一致（同一虚拟地址有多条记录时 p2p 优先、其次延迟低），
 * 这样"提示里的数字"和"连接路径里那一行"永远是同一个数。
 *
 * `isHost = true`（本机就是房主）时返回 null：没有"到自己的链路"这回事。
 */
export function hostRoute(peers: readonly PeerView[], hostIp: string, isHost = false): RouteSample | null {
  if (isHost) return null;
  const target = bareIp(hostIp);
  if (target.length === 0) return null;
  return bestRoutes(peers).find((r) => bareIp(r.key) === target) ?? null;
}

export interface HostLinkQuality {
  /** 房主的虚拟地址（裸地址）；空串 = 拿不到（不在房间 / 票据没带） */
  hostIp: string;
  /** 到房主那条链路（归并后）；null = 本机是房主，或 peer list 里还没有房主 */
  route: RouteSample | null;
  /** 到房主走的是 P2P 直连 —— 只有这种情况才谈得上"强制走中继" */
  direct: boolean;
  /** 到房主**直连**的丢包率；null = 这一窗没有可判断的样本 */
  lossRate: number | null;
  /** lossRate 是否超过阈值（lossRate 为 null 时 false） */
  over: boolean;
}

/**
 * 「到房主」这一条链路的质量快照 —— 房间页提示、连接诊断、自动回落**共用它**。
 *
 * 三处共用同一个纯函数，是为了让口径不可能漂移：上一版的毛病正是
 * 列表按"是不是平台中继"分组、而提示按 `cost` 判定，两套口径各说各话。
 *
 * 有效样本（lossRate 非 null）要求三件事同时成立：
 *   1. 本机**不是**房主 —— 本机是房主时没有"到房主"的链路，判定不适用；
 *   2. 到房主是**直连**（cost = p2p）—— 已经走中继的人，"强制走中继"对他毫无意义；
 *   3. 那条链路**测到了读数** —— 拿不到读数（旧版本/刚进房）时不拿未知当证据。
 *
 * 中继节点自己丢多少包**不进这里**：界面上照常逐行显示（那是它自己的质量），
 * 但它不驱动任何结论、提示与回落。
 */
export function hostLinkQuality(peers: readonly PeerView[], hostIp: string, isHost = false): HostLinkQuality {
  const route = hostRoute(peers, hostIp, isHost);
  const direct = route !== null && linkKind(route.cost) === 'p2p';
  const lossRate = direct ? route.lossRate : null;
  return {
    hostIp: bareIp(hostIp),
    route,
    direct,
    lossRate,
    over: lossRate !== null && lossRate > LOSS_THRESHOLD,
  };
}

/**
 * A/B 对照：切到中继之后，**到房主**现在这条路是不是比刚才的直连更差。
 *
 * 只在**同一个节点**上前后对比（key 是虚拟地址）—— 自动回落的基线现在只有一条
 * （`hostRoute` 取到的那条，也就是房主），切到中继后再取一次同一个地址，
 * 所以比较天然落在"我到房主：直连 vs 中继"上，不会拿 A 的中继延迟去比 B 的直连延迟。
 * 返回 true 表示"中继更差，这次判断不可信，应该切回去"。
 */
export function relayLooksWorse(baseline: readonly RouteSample[], after: readonly RouteSample[]): boolean {
  const now = new Map(after.map((r) => [r.key, r]));
  for (const before of baseline) {
    if (before.lossRate === null) continue;
    const current = now.get(before.key);
    if (!current || linkKind(current.cost) === 'p2p') continue;

    // 中继自己也在丢 → 丢包发生在更靠上游的地方，换路解决不了
    if (current.lossRate !== null && current.lossRate >= AB_RELAY_LOSS_TOLERANCE) return true;

    if (before.latencyMs !== null && current.latencyMs !== null) {
      const delta = current.latencyMs - before.latencyMs;
      if (delta >= AB_LATENCY_ABS_MS && current.latencyMs > before.latencyMs * AB_LATENCY_RATIO) return true;
    }
  }
  return false;
}

/** 退避档位：15min → 30min → 60min（封顶） */
export function nextProbeDelay(current: number): number {
  return Math.min(PROBE_MAX_MS, Math.max(PROBE_BASE_MS, current * PROBE_FACTOR));
}

/**
 * 丢包率的显示文本。**唯一的格式化入口** —— 房间页、连接诊断、提示文案都用它，
 * 免得同一份数据在两处一个显示 "5.3%"、另一个显示 "0.053"。
 * 拿不到时显示 `—`（仓库既有的"未知"写法），不显示 0%：0% 是"测得没丢包"，
 * 两者含义完全不同，混在一起会让玩家以为链路正常。
 */
export function formatLoss(loss: number | null): string {
  return loss === null ? '—' : `${(loss * 100).toFixed(1)}%`;
}

/* ============================================================== 本机偏好持久化 */

/*
 * 为什么存在 localStorage 而不是主控：
 * 「这条线路在我这台机器上不行」是本机事实，换台电脑没有意义，也不该被主控收集。
 * 与 lib/shortcuts.ts（收藏/最近）同一套取舍。
 */

const FORCED_ROOMS_KEY = 'mclink.relay.forcedRooms';
const AUTO_FALLBACK_KEY = 'mclink.relay.autoFallback';
/** 过期条目（房间早就不在了）不该无限堆积 */
const FORCED_ROOMS_MAX = 30;

/** 是谁把这条链路钉到中继上的：玩家自己点的，还是自动回落替它做的 */
export type RelaySource = 'manual' | 'auto';

/**
 * 存的是 `{ 房间 id: 'manual' | 'auto' }` 而不是一个布尔数组。
 *
 * 来源必须一起存下来：两者**后续行为完全不同** —— 自动降级会被定时放 P2P 重试，
 * 而玩家手动钉住的中继谁都不许自动撤销（那是他明确表达过的意图）。
 * 只存布尔的话，客户端重启一次"自动"就会被误当成"手动"，自动重试永远不再发生。
 */
function readForcedRooms(): Record<string, RelaySource> {
  try {
    const raw = JSON.parse(localStorage.getItem(FORCED_ROOMS_KEY) ?? '{}') as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, RelaySource> = {};
    for (const [roomId, source] of Object.entries(raw as Record<string, unknown>)) {
      if (roomId.length === 0) continue;
      if (source === 'manual' || source === 'auto') out[roomId] = source;
      if (Object.keys(out).length >= FORCED_ROOMS_MAX) break;
    }
    return out;
  } catch {
    return {};
  }
}

function writeForcedRooms(map: Record<string, RelaySource>): void {
  try {
    localStorage.setItem(FORCED_ROOMS_KEY, JSON.stringify(map));
  } catch {
    /* 隐私模式/配额满：降级为「本次会话有效」，不影响联机本身 */
  }
}

/**
 * 这个房间是否被本机钉住走中继，以及是谁钉的。
 *
 * 按房间记而不是全局一个开关：劣化是「我和这个房间里某个人之间」的事，
 * 换个房间（换一批对端）结论可能完全相反。持久化则是硬要求 ——
 * 重启客户端后重新进同一个房间，开关必须还是开着的。
 */
export function loadForceRelay(roomId: string): RelaySource | null {
  if (roomId.length === 0) return null;
  return readForcedRooms()[roomId] ?? null;
}

export function saveForceRelay(roomId: string, source: RelaySource | null): void {
  if (roomId.length === 0) return;
  const map = readForcedRooms();
  if (source === null) delete map[roomId];
  else map[roomId] = source;
  writeForcedRooms(map);
}

/** 自动回落：**默认关**。它会在玩家没察觉的时候重启核心，必须由玩家自己打开。 */
export function loadAutoFallback(): boolean {
  try {
    return localStorage.getItem(AUTO_FALLBACK_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveAutoFallback(on: boolean): void {
  try {
    localStorage.setItem(AUTO_FALLBACK_KEY, on ? '1' : '0');
  } catch {
    /* 同上 */
  }
}
