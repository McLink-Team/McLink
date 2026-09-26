/**
 * 「P2P 质量差 → 回落中继」的判据、票据改写与本机偏好。
 *
 * 为什么需要它：打洞成功不等于链路可用。P2P 直连走的是两个玩家各自的家宽，
 * 中间任何一跳拥塞都会表现为**丢包**——延迟看着还行（20ms），但游戏里人物会回弹。
 * 这种时候绕一次中继反而更稳。EasyTier 自己一直在算丢包（`loss_rate`，
 * 最近 100 次探测的滑动窗口），`peer list` 里就有这一列，我们只需要读出来 + 决定要不要绕。
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
 * 中继侧自己也丢 ≥2% → 判定"问题不在 P2P 那段"。
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

export interface P2pQuality {
  /** 测得丢包的 P2P 节点数 */
  measured: number;
  /** 这些节点是否**全部**超标 */
  allOver: boolean;
  /** 其中最高的丢包率（没测到时为 null） */
  worstLoss: number | null;
}

/**
 * P2P 侧质量快照。
 *
 * 为什么触发条件要求"**所有**测得到的 P2P 节点都超标"，而不是"有任何一个超标"：
 * `disable_p2p` 是**本实例全局**的开关，一开就把全部直连路径一起关掉。
 * 一个三人房间里只有一个人丢包时，为了他绕中继会把另外两条好链路一起拖慢 ——
 * 净效果未必是改善。所以自动回落只在"直连整体不行"时动作；
 * 单个人劣化属于"玩家自己判断"的场景，交给房间页那个手动开关。
 */
export function p2pQuality(peers: readonly PeerView[]): P2pQuality {
  const direct = bestRoutes(peers).filter((r) => linkKind(r.cost) === 'p2p' && r.lossRate !== null);
  if (direct.length === 0) return { measured: 0, allOver: false, worstLoss: null };
  const losses = direct.map((r) => r.lossRate ?? 0);
  return {
    measured: direct.length,
    allOver: losses.every((loss) => loss > LOSS_THRESHOLD),
    worstLoss: Math.max(...losses),
  };
}

/**
 * A/B 对照：切到中继之后，同一个人现在这条路是不是比刚才的直连更差。
 *
 * 只在**同一个节点**上前后对比（key 是虚拟地址），不拿 A 的中继延迟去比 B 的直连延迟 ——
 * 不同的人在不同城市，横向比毫无意义。
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
