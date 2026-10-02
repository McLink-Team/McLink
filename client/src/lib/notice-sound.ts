/**
 * 平台提示的**提示音**（"叮咚"）。
 *
 * 用途（用户 2026-10-03 要的）：中继节点负载到线时，除了横幅和房间里的系统消息，
 * 新版客户端**额外响一声** —— 玩家多半正全屏打游戏，不看横幅，声音才是能穿透注意力的那一层。
 *
 * 为什么用 WebAudio 现场合成、不带音频资源：
 *   · 一个 300ms 的双音"叮咚"用两个振荡器就够了（见下），不必往安装包里塞 wav/mp3，
 *     也不必处理"资源路径在打包后变了"这类问题（Electron 与安卓 WebView 都会遇到）；
 *   · 音色可以随平台调（下面这组参数就是"叮咚"的感觉：先高后低、指数衰减）。
 *
 * 三层保险，**任何一层都不能反过来影响房间逻辑**：
 *   1. 跟随设置页的「有人发消息时提醒我」开关 —— 关掉就一条都不响（`soundEnabled` 注入）；
 *   2. 节流：同一房间 5 秒内只响一次（主控那边过载通知本身有冷却，这里是第二道）；
 *   3. 全程 try/catch 静默失败：AudioContext 被策略挡住（比如安卓 WebView 没有用户手势）、
 *      没有音频设备、`window.AudioContext` 不存在 —— 都只是"没响"，绝不影响别的功能。
 */

/** 同一房间两次提示音之间的最小间隔（毫秒） */
export const SOUND_THROTTLE_MS = 5_000;

/** 叮咚的两个音（Hz）与时长：高音在前、低音在后，各自指数衰减 */
const CHIME = [
  { freq: 880, startMs: 0, durationMs: 160 },
  { freq: 587.33, startMs: 130, durationMs: 260 },
];

const lastPlayedAt = new Map<string, number>();
let audioContext: AudioContext | null = null;

/**
 * 开关探针：默认开。store 在安装通知运行时把它接上（跟随同一个设置开关，
 * 免得设置页多出一个"提示音"开关要维护）。
 */
let enabledProbe: () => boolean = () => true;

export function setSoundEnabledProbe(next: (() => boolean) | null): void {
  enabledProbe = next ?? (() => true);
}

function context(): AudioContext | null {
  if (audioContext) return audioContext;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    audioContext = new Ctor();
  } catch {
    return null;
  }
  return audioContext;
}

/**
 * 响一声"叮咚"。`key` 用来节流（一般传房间 id）：同一个 key 在
 * `SOUND_THROTTLE_MS` 之内只响一次。返回是否真的响了（排查/测试用）。
 */
export function playNoticeSound(key = ''): boolean {
  try {
    if (!enabledProbe()) return false;
    const now = Date.now();
    const last = lastPlayedAt.get(key) ?? 0;
    if (now - last < SOUND_THROTTLE_MS) return false;

    const ctx = context();
    if (!ctx) return false;
    // 安卓 WebView / 自动播放策略：上下文可能是 suspended，需要一次 resume（失败就算了）
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});

    const start = ctx.currentTime + 0.01;
    for (const note of CHIME) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = note.freq;
      const at = start + note.startMs / 1000;
      const end = at + note.durationMs / 1000;
      // 起音立刻到 0.18、随后指数衰减：直接给 0 会"啪"一下，直接停会"咔"一下
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(at);
      osc.stop(end + 0.02);
    }
    lastPlayedAt.set(key, now);
    return true;
  } catch {
    return false;
  }
}

/** 测试/排查：清掉节流记录 */
export function resetNoticeSoundThrottle(): void {
  lastPlayedAt.clear();
}
