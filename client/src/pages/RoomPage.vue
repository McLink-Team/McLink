<script setup lang="ts">
/**
 * 房间页 —— 进房后的主界面。
 *
 * **两栏**（用户给的参照是一个桌面启动器的房间界面，但内容全是本产品真实有的东西）：
 *   左栏 2fr：成员大卡 → 连接路径 → 房间聊天。这一栏是"房间里发生了什么"。
 *   右栏 1fr：房间卡（房间名 / 加入码 / 联机地址 / 动作）→ 我的网络 → 连接诊断 → 联机帮助。
 *   这一栏是"这个房间是什么、我能对它做什么"。
 *
 * 为什么这么分而不是继续单列往下堆：进房后玩家只有两类问题 ——
 * 「谁进来了、通不通」（左）和「把地址发出去 / 改规则 / 走人」（右）。
 * 单列时这两类事按时间顺序交替出现，找"关房间"要滚过整屏的成员与聊天。
 *
 * 宽度用 `grid-template-columns: 2fr 1fr` 而不是固定像素：fr 分配的是**整条轨道**，
 * 两栏宽度比因此恒为 2:1（940 窗口实测 537 / 269）。窄于 820 回落一栏 ——
 * 那时图标栏吃掉 80 之后，1/3 侧栏只剩 236px，房间卡的按钮会开始竖着叠。
 *
 * 几处刻意的取舍：
 *   · **联机地址仍然整块可点即复制**（本产品最核心的动作），但只留一行"点一下即复制"。
 *     原来铭牌下面那段"不少游戏要连端口 / 端口看游戏提示"的长句已删掉 ——
 *     端口属于"按游戏查"的资料，只在「联机帮助」里讲，房间里不再出现解释性长句。
 *   · 成员行的"本机"标记优先于"房主"：自己那一行玩家一眼要认出的是自己，
 *     房主身份在别人那行才有信息量。
 *   · 头像用暖色单调圆 + 首字母（参照稿的形态）：不需要任何素材，也不假装有插画。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { formatBitrate, formatBytes, regionLabel } from '@mclink/shared';
import {
  applyHostAclIfNeeded,
  approveMember,
  clientState,
  closeRoom,
  hostVirtualIp,
  isHost,
  isOnline,
  kickMember,
  leaveRoom,
  pollPeers,
  refreshRoom,
  relayMode,
  rotateSecret,
  shareAddress,
  toggleForceRelay,
  updateRoomPolicy,
  applyRelayHint,
  dismissRelayHint,
} from '../lib/store.ts';
import type { PeerView } from '../lib/easytier-parse.ts';
import { linkKind } from '../lib/easytier-parse.ts';
import { LOSS_THRESHOLD, formatLoss, hostLinkQuality } from '../lib/relay-fallback.ts';
import { relayRoleOf, type RelayTicketNames } from '../lib/relay-roles.ts';
import { friendlyError } from '../lib/api.ts';
import { copyText } from '../lib/clipboard.ts';
import { confirmInApp } from '../lib/confirm.ts';
import { isFavorite, shortcutsRevision, toggleFavorite } from '../lib/shortcuts.ts';
import { isMac, platform, supportsLanBroadcast } from '../lib/platform.ts';
import { setRoomOnScreen } from '../lib/store.ts';
import ChatPanel from '../components/ChatPanel.vue';
import ConnectionDiagnostic from '../components/ConnectionDiagnostic.vue';
import GameQuickConnect from '../components/GameQuickConnect.vue';

const copied = ref('');
const busy = ref(false);
const error = ref('');
const policyOpen = ref(false);
const inviteOpen = ref(false);
/** 「联机帮助」二级菜单：房间页上只留一行入口，内容进弹层 */
const helpOpen = ref(false);
/**
 * 连接诊断默认**收起**。
 * 它的数据来自 easytier-cli 的两次调用，进房后还要先等 5 秒 —— 常驻展开等于每次
 * 进房都占掉右栏一大块，而它是"要看的时候才看"的东西（用户要求默认不展开）。
 * 收起时不挂载组件，顺带省掉那两次调用与 5 秒等待。
 */
const diagOpen = ref(false);
const policy = ref({
  maxPlayers: 8,
  maxBandwidthKbps: 0,
  perMemberKbps: 0,
  rateLimitPps: 0,
  allowedPorts: '',
  strictPorts: false,
  allowP2p: true,
  /** 局域网广播直通：默认关闭，开启要装内核驱动，代价写在弹层说明里 */
  allowBroadcast: false,
});

const session = computed(() => clientState.session);
const room = computed(() => session.value?.room ?? null);
const members = computed(() => session.value?.members ?? []);
const pending = computed(() => members.value.filter((m) => m.status === 'pending'));

/** 平台名字：用在"本平台不支持某功能"的说明里，免得只写"当前平台"让人不知道自己在哪 */
const platformLabel = isMac ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';

/* ------------------------------------------------------- 成员"在线"判定 */

/**
 * 心跳新鲜度窗口 —— 与服务端算「在线 x/y」用的是同一个数（90 秒）。
 *
 * 服务端 `online_members` 只统计 `last_seen_at > now-90s` 的成员，
 * 而成员列表返回的是所有 active/pending 行 —— 两边口径不同，
 * 所以"成员列表 2 人、在线 1/8"是可以同时成立的：那个人 90 秒没心跳了。
 * 界面上必须把这件事画出来，否则玩家只会觉得数字坏了。
 */
const STALE_MS = 90_000;

/**
 * 只为了让"离线"自己出现而走的时间。
 * 对方的掉线**不会**产生 WebSocket 事件（没有事件可推），
 * 所以不能只靠数据变化触发重算 —— 需要一个本地时钟。
 */
const nowMs = ref(Date.now());
const clockTimer = window.setInterval(() => {
  nowMs.value = Date.now();
}, 15_000);
onUnmounted(() => window.clearInterval(clockTimer));

/**
 * 「正看着这个房间」由本页的存在本身来表达：RoomPage 只在 `view === 'home' && hasRoom`
 * 时被 App.vue 渲染，所以挂载 = 玩家眼前就是聊天面板，卸载 = 他离开了这一屏。
 *
 * 为什么不让通知模块自己去问主进程窗口状态：窗口聚焦与"看着房间"是两件事 ——
 * 聚焦着停在设置页时消息是看不见的（该弹），收进托盘但页面还挂着时也看不见（该弹）。
 * 只有这里知道后者，所以由这里写、别处只读（store 的 roomOnScreen）。
 */
onMounted(() => setRoomOnScreen(true));
onUnmounted(() => setRoomOnScreen(false));

const isStale = (m: { lastSeenAt: string | null }): boolean => {
  if (!m.lastSeenAt) return true;
  const at = Date.parse(m.lastSeenAt);
  return !Number.isFinite(at) ? true : nowMs.value - at > STALE_MS;
};

const lastSeenText = (m: { lastSeenAt: string | null }): string => {
  if (!m.lastSeenAt) return '未知';
  const at = Date.parse(m.lastSeenAt);
  if (!Number.isFinite(at)) return '未知';
  const seconds = Math.max(0, Math.round((nowMs.value - at) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.round(minutes / 60)} 小时前`;
};

/* ------------------------------------------------------------- 成员行视图 */

/**
 * 一行的全部显示事实在**这里**算完，模板里只剩摆位。
 *
 * 为什么不在模板里写一串 `m.status === 'pending' ? … : m.p2p ? …`：
 * 链路徽标、状态点、离线文案看着是三处，其实是**同一个判断**的三个出口。
 * 分开写就一定会漂移（上一版实测出过：徽标写"直连"、状态点却是灰的）。
 */
interface MemberRow {
  userId: string;
  displayName: string;
  status: string;
  role: string;
  /** "本机"优先于"房主"：自己那一行玩家先要认出自己 */
  roleBadge: string | null;
  linkLabel: string;
  linkClass: string;
  dotClass: string;
  virtualIp: string | null;
  deviceName: string | null;
  latencyText: string | null;
  lastSeen: string | null;
}

const memberRows = computed<MemberRow[]>(() =>
  members.value.map((m) => {
    /**
     * 三种"没在直连"要分开：**刚进房还没上报**、**心跳超时**、**待审批**。
     * 合成一个"离线"是错的：房间刚建好时所有人的 lastSeenAt 都还是 null
     * （服务端插入成员时写 null，要等第一次心跳 + 30 秒一次的成员刷新才填上），
     * 那时把自己标成"离线"看着就像坏了。
     */
    const noBeat = m.lastSeenAt === null;
    const stale = !noBeat && isStale(m);
    const self = m.userId === (clientState.user?.id ?? '');
    const waiting = m.status === 'pending';
    const link = waiting
      ? { label: '待审批', cls: 'badge-warn' }
      : noBeat
        ? { label: '尚未心跳', cls: 'badge-neutral' }
        : stale
          ? { label: '离线', cls: 'badge-warn' }
          : m.p2p
            ? { label: 'P2P 直连', cls: 'badge-ok' }
            : { label: '经中继', cls: 'badge-neutral' };
    return {
      userId: m.userId,
      displayName: m.displayName,
      status: m.status,
      role: m.role,
      roleBadge: self ? '本机' : m.role === 'host' ? '房主' : null,
      linkLabel: link.label,
      linkClass: link.cls,
      // 状态点与徽标同源：待审批/离线是琥珀，还没心跳是灰，在线是绿 ——
      // 颜色不单独传达状态，徽标上都有字。
      dotClass: waiting || stale ? 'led-warn' : noBeat ? 'led-signal' : 'led-ok',
      virtualIp: m.virtualIp,
      deviceName: m.deviceName,
      latencyText: !stale && !noBeat && m.latencyMs !== null ? `${m.latencyMs.toFixed(0)} ms` : null,
      lastSeen: stale ? `最后心跳 ${lastSeenText(m)}` : null,
    };
  }),
);

/**
 * 「连接路径」的清洗与分组。
 *
 * `easytier-cli peer list` 是**按路径**列的，不是按节点：同一个成员可能同时出现一条
 * P2P 直连和一条经中继的记录，本机自己也会出现在列表里。原样铺出来就是
 * 「我自己出现两次、其中一条还标着 1000 ms」——玩家会以为网络坏了（实测截图就是这样）。
 *
 * 清洗分三步：
 *   1. 剔除本机（注意本机 virtualIp 带 /24 掩码，peer list 里是裸地址，不剥掩码比不中）；
 *   2. 按虚拟地址归并同一节点的多条路径，优先保留 P2P、其次延迟更低的；
 *   3. **按「房间成员 / 中继节点」分组** —— 这是玩家最容易误解的地方：平台现在给每个房间
 *      下发 **2 个不同的中继子节点**（主 + 兜底），它们各占一行，看起来像"我同时连了两台服务器"。
 *      实际业务流量走主中继，兜底只在主中继不可用时接管；但 EasyTier 平时也会维持到兜底的
 *      连接（保活 / 路由同步），所以两边都有几 KB 流量。分组 + 「主中继 / 兜底」标注
 *      把这个事实直接讲清楚，而不是让玩家自己猜。
 */
const visiblePeers = computed<PeerView[]>(() => {
  const selfIp = (session.value?.virtualIp ?? '').split('/')[0];
  const routeScore = (p: PeerView): number => (p.cost.startsWith('p2p') ? 0 : 10_000) + (p.latencyMs ?? 5_000);
  const best = new Map<string, PeerView>();
  for (const p of clientState.peers) {
    if (selfIp && (p.ipv4 ?? '').split('/')[0] === selfIp) continue;
    const key = p.ipv4 || p.hostname || '';
    const prev = best.get(key);
    if (!prev || routeScore(p) < routeScore(prev)) best.set(key, p);
  }
  return [...best.values()].sort((a, b) => routeScore(a) - routeScore(b));
});

/** 成员虚拟地址集合（裸地址）：用来把 peer 分成「成员」与「中继」两组 */
const memberIps = computed(
  () => new Set(members.value.map((m) => (m.virtualIp ?? '').split('/')[0]).filter(Boolean)),
);
const isMemberPeer = (p: PeerView): boolean => memberIps.value.has((p.ipv4 ?? '').split('/')[0]);
const memberPeers = computed(() => visiblePeers.value.filter(isMemberPeer));
const relayPeers = computed(() => visiblePeers.value.filter((p) => !isMemberPeer(p)));

/* --------------------------------------------------------- 打洞 / 中继角色 */

/**
 * 两个槽位的角色判定：判据与"为什么要剥 `PublicServer_` 前缀"全部写在
 * `lib/relay-roles.ts`（纯函数，回归脚本 `scripts/verify-relay-roles.mjs` 钉着它）。
 * 这里只负责把票据里的 label 取出来喂进去。
 */
/** 票据里的中继名字：`punch` 是打洞节点（无票据时为 null），`all` 用于确认名字认不认得出来 */
const relayNames = computed<RelayTicketNames>(() => {
  const relays = session.value?.ticket?.relays ?? [];
  const punchId = session.value?.room?.relayNodeIds?.[0];
  const byId = punchId ? relays.find((r) => r.nodeId === punchId) : undefined;
  return { punchLabel: byId?.label ?? relays[0]?.label ?? null, allLabels: relays.map((r) => r.label) };
});

const relayRole = (p: PeerView): 'punch' | 'relay' | null => relayRoleOf(p.hostname ?? '', relayNames.value);

/**
 * 认不出角色时，把**两边的原始名字**摆在界面上（而不是只写「角色未知」）。
 *
 * 为什么这么做：这一条判据的口径是"内核报的 hostname ↔ 票据里的节点名"，
 * 两者一旦对不上，光看界面根本不知道差在哪（上一轮就是靠猜，来回装了两遍包）。
 * 把票据里的名字直接显示出来，截图一眼就能看出是"名字被改过""带了别的前缀"，
 * 还是"票据里压根没有这台"。
 */
const relayNameHint = computed(() => {
  const labels = relayNames.value.allLabels.filter((l) => l.trim().length > 0);
  if (labels.length === 0) return '票据里没有中继名单（老主控？）';
  return `票据中继：${labels.join('、')}`;
});

/* ------------------------------------------------------- 丢包与回落中继 */

/**
 * 丢包读数与提示。
 *
 * **判据只有一条链路：本机 → 房主**。口径由 `lib/relay-fallback.ts` 的
 * `hostLinkQuality` 统一给出 —— 房间页、连接诊断、自动回落共用同一个纯函数，
 * 免得三处各写一套（上一版的毛病正是列表按"是不是平台中继"分组、
 * 而提示按 `cost` 判定，两套口径互相矛盾）。
 *
 * 为什么不能按 `cost = p2p` 判定（上一版的 bug，用户实测抓到）：
 * `cost = p2p` 只说明**本机到那个节点**之间是直连 —— 我们到平台下发的中继节点
 * 本来就常常是直连。上一版取"所有 p2p 里最大的丢包"，于是"到中继服务器的直连"
 * 被当成了"玩家之间的 P2P"：房间里四条连接全是中继节点（`PublicServer_阿里云上海` /
 * `华南-A` / `relay-sh` / `海外-A`），顶部却报「P2P 直连在丢包（最高 8.0%）」，
 * 而 8% 那条正是中继 `PublicServer_relay-sh`。
 * 真正决定游戏手感的只有房主那条链路：房主跑着游戏服务端。
 *
 * 用户给的四条规则在下面各有一处落点：
 *   1. 只看到房主那条（按**虚拟地址**在 peer list 里匹配，不按 cost）；
 *   2. 本机是房主 → 值为 null、提示不出现，位置上给一句"这项不适用"的说明；
 *   3. 中继节点自己的丢包照常逐行显示（那是它的质量），但不进这个结论；
 *   4. 非房主但到房主走中继 → 不判定、不提示（他已经在走中继了，
 *      "强制走中继"对他没有任何意义）。
 *
 * 颜色只是强化 —— 数字本身（`丢包 5.3%` vs `丢包 0.0%`）就是文字通道，
 * 而且高出阈值时上面还会多出那条带动作的提示，不靠颜色单独传达任何东西。
 */
const isHighLoss = (p: PeerView): boolean => p.lossRate !== null && p.lossRate > LOSS_THRESHOLD;

/** 到房主那条链路的质量快照（本页唯一判据；房主本人的 hostVirtualIp 是自己的地址） */
const hostLink = computed(() => hostLinkQuality(clientState.peers, hostVirtualIp.value, isHost.value));
/** 到房主的**直连**丢包；null = 本机是房主 / 走中继 / 还没读数 —— 三种都"不判定" */
const hostLoss = computed(() => hostLink.value.lossRate);

/** 已经走中继时不再劝他走中继 —— 提示只在"还能选择"的时候出现 */
const lossTipVisible = computed(() => relayMode.value === 'off' && hostLink.value.over);

/**
 * 提示条不出现时，同一个位置上的那一行说明 —— **不留空判定**。
 *
 * 房主看到的是"这项不适用"（而不是一个永远为空的指标）；非房主看到的是
 * "到房主现在走的是什么路、丢多少" —— 这样"P2P 丢包只看房主那条"这条规则
 * 在界面上是看得见的，玩家也能自己判断这条读数可不可信。
 */
const hostLinkNote = computed<string>(() => {
  if (isHost.value) return '你是房主：房间里所有人都是连到你，没有「本机 → 房主」这条链路，这项不适用。';
  const q = hostLink.value;
  if (!q.route) return '到房主：连接路径里还没有房主的节点（等下一次刷新）。';
  // 走中继时如实报中继链路自己的读数（规则 3），但说清它不参与 P2P 结论（规则 4）
  if (!q.direct) return `到房主：经中继，丢包 ${formatLoss(q.route.lossRate)}（中继自身的质量，不参与 P2P 判定）。`;
  return `到房主：P2P 直连，丢包 ${formatLoss(q.lossRate)}。`;
});

/**
 * 行内丢包读数的 title。
 *
 * 「可以强制走中继」这句建议**只有到房主的那条直连**配说 —— 上一版只要
 * `cost = p2p` 就挂上这句，而本机到中继节点往往也是直连，于是中继节点自己丢包
 * 也会被劝"强制走中继"（他已经在走中继了，这话毫无意义）。
 */
function lossTitle(p: PeerView): string {
  const base = 'EasyTier 统计的丢包率（最近 100 次探测的滑动窗口）';
  if (!isHighLoss(p)) return base;
  const isHostRow = (p.ipv4 || '').split('/')[0] === hostVirtualIp.value;
  if (isHostRow) {
    return linkKind(p.cost) === 'p2p'
      ? `${base}：这是到房主的直连在丢包，可以强制走中继`
      : `${base}：这是到房主的路径，走的是中继（中继自身在丢包，换路解决不了）`;
  }
  if (isMemberPeer(p)) {
    return linkKind(p.cost) === 'p2p'
      ? `${base}：这条直连在丢包，但它不是到房主的那条（判定只看房主）`
      : `${base}：这条路径在丢包（经中继，不是直连）`;
  }
  // 平台中继节点：本机到它常常是直连，但那不是"玩家之间的 P2P"
  return `${base}：这条中继路径在丢包（中继自身的质量，不参与 P2P 判定）`;
}

/* ------------------------------------------------ 「强制走中继」开关的四种状态 */

/**
 * 文案与禁用条件全部由 store 的 `relayMode` 一个判据派生（见 store.ts）。
 * 房主在房间规则里关掉 P2P 时，这个开关是**只读**的：让他看得出"不是我能改的事"。
 */
const relayLabel = computed(() => {
  switch (relayMode.value) {
    case 'policy':
      return '全员走中继';
    case 'switching':
      return '切换中…';
    case 'on':
      return '已走中继';
    default:
      return '强制走中继';
  }
});

const relayDisabled = computed(
  () => relayMode.value === 'policy' || relayMode.value === 'switching' || busy.value || !isOnline.value,
);

const relayTitle = computed(() => {
  switch (relayMode.value) {
    case 'policy':
      return '房主在房间规则里关闭了「允许 P2P 直连」，全房间都走中继，本机无法单独改回';
    case 'switching':
      return '正在用新配置重启本地核心，连接会中断几秒';
    case 'on':
      return '点一下切回 P2P 直连（会重启本地核心，中断几秒）';
    default:
      // 「直连」而不是「P2P 直连」：本机到中继节点也是直连，用"P2P"会把它一起说进去
      return '强制走中继：所有流量经中继转发，绕开丢包的直连（会重启本地核心，中断几秒）';
  }
});

/**
 * 状态行只在"有事要说"时出现（切换中 / 已切到中继 / 房主设定 / 刚切回来的结果），
 * 静止的"正在直连"不占一行 —— 房间卡里每一行都要有存在的理由。
 */
const relayStateText = computed(() => {
  if (relayMode.value === 'policy') return '房主已关闭 P2P 直连，全房间走中继。';
  if (relayMode.value === 'switching') return '正在切换，几秒内恢复。';
  if (clientState.relayNotice) return clientState.relayNotice;
  // 结果行（"是谁切的、为什么"）由 store 的 setForceRelay 给；这里只兜住它被清空之后的情况
  if (relayMode.value === 'on') return '已切到中继：所有流量经中继转发。';
  return '';
});

const relayLedClass = computed(() => (relayMode.value === 'switching' ? 'led-warn' : 'led-ok'));

/**
 * 平台建议切换中继 → 玩家点了「现在切换」。
 *
 * 这是一次**真实的中断**（本地核心重启、隧道断几秒），和「强制走中继」同一量级，
 * 所以走同一套应用内确认弹层 —— 绝对不能在玩家没点确认时自己切（主控也只发建议）。
 * 注意切换用的是 `reenterRoom()`：它**不调 leave**，所以房主点它也不会关房。
 */
async function onApplyRelayHint(): Promise<void> {
  const ok = await confirmInApp({
    title: '切换到更空闲的中继',
    message: '重新取一次票据并重建本地核心。',
    detail:
      '连接会中断几秒，房间里其他人不受影响。你正在打的重要进度不会丢（联机本身会短暂卡一下），' +
      '想等这局结束再切就点「稍后」。',
    confirmText: '现在切换',
    danger: false,
  });
  if (!ok) return;
  await applyRelayHint();
}

/**
 * 切换确认。两个方向都要问：无论开关还是关，本地核心都会重启、连接都会断几秒，
 * 这不是"改一个偏好"，是一次真实的中断（与「轮换密钥」「关闭房间」同一量级，
 * 所以走同一套应用内确认弹层）。
 */
async function doToggleRelay(): Promise<void> {
  const mode = relayMode.value;
  if (mode === 'policy' || mode === 'switching') return;
  const turningOn = mode !== 'on';
  const ok = await confirmInApp(
    turningOn
      ? {
          title: '强制走中继',
          message: '所有流量改走中继，P2P 直连停用。',
          detail:
            '本机会用新配置重启一次 EasyTier 核心，连接中断约 3 秒。房间里其他人不受影响；这个选择会记住，重启客户端后仍然生效。',
          confirmText: '走中继',
          danger: false,
        }
      : {
          title: '切回 P2P 直连',
          message: '重新尝试和其它成员打洞直连。',
          detail:
            '本机会用新配置重启一次 EasyTier 核心，连接中断约 3 秒。如果当初是为了绕开丢包才切过来的，直连恢复后可能又会丢包。',
          confirmText: '切回直连',
          danger: false,
        },
  );
  if (!ok) return;
  busy.value = true;
  error.value = '';
  try {
    await toggleForceRelay();
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}

const favorite = computed(() => {
  void shortcutsRevision.value;
  const current = room.value;
  return current ? isFavorite(current.id) : false;
});

/** 一键粘贴到群里的邀请信息（多行纯文本）。刻意不含任何服务器地址。 */
const inviteText = computed(() => {
  const current = room.value;
  return [
    `【McLink 联机邀请】${current?.name ?? ''}`,
    `加入码：${current?.code ?? ''}`,
    `联机地址：${shareAddress.value ?? '（等待分配）'}`,
    '',
    '怎么进：① 打开 McLink 客户端，用上面的加入码进房间；② 启动游戏 → 多人游戏 → 直接连接 → 粘贴上面的联机地址。',
  ].join('\n');
});

function initial(name: string): string {
  return (name || '?').trim().slice(0, 1);
}

function copy(text: string, tag: string): void {
  void copyText(text).then((ok) => {
    if (!ok) {
      error.value = '复制失败：请按住鼠标选中地址后按 Ctrl+C';
      return;
    }
    copied.value = tag;
    setTimeout(() => {
      if (copied.value === tag) copied.value = '';
    }, 1800);
  });
}

function openPolicy(): void {
  const p = room.value?.policy;
  if (!p) return;
  policy.value = {
    maxPlayers: p.maxPlayers,
    maxBandwidthKbps: p.maxBandwidthKbps,
    perMemberKbps: p.perMemberKbps,
    rateLimitPps: p.rateLimitPps,
    allowedPorts: p.allowedPorts.join(','),
    strictPorts: p.strictPorts,
    allowP2p: p.allowP2p,
    allowBroadcast: p.allowBroadcast,
  };
  policyOpen.value = true;
}

/** 收藏 / 取消收藏当前房间（只写本机 localStorage） */
function toggleFav(): void {
  const current = room.value;
  if (!current) return;
  toggleFavorite({
    roomId: current.id,
    code: current.code,
    name: current.name,
    lastAddress: shareAddress.value ?? null,
    lastSeenAt: new Date().toISOString(),
  });
}

/** 联机地址是玩家最常要发出去的东西：点整块就能复制，不用瞄准按钮 */
function copyAddress(): void {
  const value = shareAddress.value;
  if (!value) return;
  copy(value, 'addr');
}

async function savePolicy(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await updateRoomPolicy({
      maxPlayers: policy.value.maxPlayers,
      maxBandwidthKbps: policy.value.maxBandwidthKbps,
      perMemberKbps: policy.value.perMemberKbps,
      rateLimitPps: policy.value.rateLimitPps,
      allowedPorts: policy.value.allowedPorts
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      strictPorts: policy.value.strictPorts,
      allowP2p: policy.value.allowP2p,
      /**
       * 「局域网广播直通」只在本平台支持时才提交。
       *
       * 为什么不是"不支持就提交 false"：那等于用一次无关的保存动作**悄悄关掉别人（Windows 成员）
       * 还能用的能力**。字段整个不带过去，房间保持服务端现有的值，mac 房主只是改不了它 ——
       * 与界面上置灰的那个下拉框语义一致（见下面 v-if="!supportsLanBroadcast" 的说明）。
       */
      ...(supportsLanBroadcast ? { allowBroadcast: policy.value.allowBroadcast } : {}),
    });
    policyOpen.value = false;
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}

async function doKick(userId: string, name: string): Promise<void> {
  // 确认走应用内弹层（lib/confirm.ts）：文案与以前的原生框逐字一致
  const ok = await confirmInApp({
    title: '踢出成员',
    message: `确定把「${name}」移出房间吗？`,
    detail: '对方会立即断开虚拟网络。房主的 EasyTier 实例可能需要短暂重连（约 2 秒）才能让规则生效。',
    confirmText: '踢出成员',
    // 破坏性动作：与成员行那颗「踢出」按钮同一套语义色（见 theme-warm.css 的 .btn-danger）
    danger: true,
  });
  if (!ok) return;
  busy.value = true;
  error.value = '';
  try {
    await kickMember(userId, '房主移出');
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}

async function doRotate(): Promise<void> {
  const ok = await confirmInApp({
    title: '轮换房间密钥',
    message: '轮换后所有成员（包括你自己）都会断开，需要用新的加入码信息重新进入。',
    detail: '网络名与密钥会一起更换，任何拿到过旧信息的人都将无法再连入。',
    confirmText: '轮换密钥',
    // 与房间动作区里那颗「轮换密钥」按钮保持一致：它是普通按钮，不是红色破坏键
    danger: false,
  });
  if (!ok) return;
  busy.value = true;
  try {
    await rotateSecret();
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}

async function doClose(): Promise<void> {
  const ok = await confirmInApp({
    title: '关闭房间',
    message: '确定关闭房间吗？所有成员都会被断开。',
    confirmText: '关闭房间',
    danger: true,
  });
  if (!ok) return;
  busy.value = true;
  try {
    await closeRoom();
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}

/**
 * 退出房间（成员侧）。
 *
 * 以前这个按钮直接调 leaveRoom()：一次误点就断网、还得重新找房主要加入码。
 * 它和「关闭房间」一样是**不可撤销地把自己踢下线**的操作，所以走同一个确认弹层。
 * 文案里必须写明"房主不受影响、自己要用加入码才能回来"——玩家对这两个后果的预期经常是反的。
 */
async function doLeave(): Promise<void> {
  const ok = await confirmInApp({
    title: '退出房间',
    message: '确定退出这个房间吗？',
    detail: '退出后会断开虚拟网络，想再进来要重新输入加入码。房间本身不受影响，其他成员照常联机。',
    confirmText: '退出房间',
    danger: true,
  });
  if (!ok) return;
  busy.value = true;
  try {
    await leaveRoom();
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <!-- room-view 让样式能按窗口宽度给这一页单独排版（见 styles.css 的响应式段） -->
  <div v-if="session && room" class="view room-view">
    <div v-if="error" class="alert alert-danger">{{ error }}</div>

    <!--
      手选节点的落地结果：被拒的节点要说清原因，并说明当前走的是兜底 ——
      不静默换掉用户的选择，也不让他以为"我选的生效了"。
    -->
    <div v-if="clientState.nodeNotice" class="alert">
      <span>
        你选择的中继节点未全部启用：
        <template v-for="(r, i) in clientState.nodeNotice.rejected" :key="r.id">
          <span class="mono">{{ r.id }}</span>（{{ r.reason }}）<template v-if="i < clientState.nodeNotice.rejected.length - 1">、</template>
        </template>
        <template v-if="clientState.nodeNotice.fallback">，当前改走平台兜底节点。</template>
        <template v-else>，当前由平台自动调度。</template>
      </span>
    </div>

    <!--
      平台的中继建议：**只是建议**，主控不会替玩家切（切一次隧道要断几秒，
      玩家可能正在打 BOSS / 比赛最后一把）。横幅给两个按钮，玩家自己决定。
    -->
    <div v-if="clientState.relayHint" class="alert alert-hint">
      <span class="grow">{{ clientState.relayHint.message }}</span>
      <button class="btn btn-sm btn-primary" type="button" @click="onApplyRelayHint">现在切换</button>
      <button class="btn btn-sm" type="button" @click="dismissRelayHint()">稍后</button>
    </div>

    <div class="room-columns">
      <!-- ================================================= 左栏：房间里发生了什么 -->
      <div class="room-main">
        <!-- 成员大卡：一行一个人，行尾一枚状态点 -->
        <section class="card stack">
          <div class="section-head">
            <span class="title">房间成员</span>
            <span class="count mono">{{ members.length }}</span>
            <span class="grow" />
            <span v-if="pending.length > 0" class="badge badge-warn">{{ pending.length }} 个待审批</span>
            <button
              class="icon-btn"
              type="button"
              title="刷新成员"
              aria-label="刷新成员"
              :disabled="busy"
              @click="refreshRoom()"
            >
              <svg viewBox="0 0 14 14" aria-hidden="true">
                <circle cx="5.4" cy="4.4" r="2.1" />
                <path d="M1.7 12.2c0-2 1.6-3.4 3.7-3.4s3.7 1.4 3.7 3.4" />
                <path d="M10.6 2.6a1.9 1.9 0 0 1 0 3.7" />
                <path d="M10.4 8.9c1.3.4 2.1 1.5 2.1 3" />
              </svg>
            </button>
          </div>

          <div v-if="memberRows.length > 0" class="member-list">
            <div v-for="r in memberRows" :key="r.userId" class="member">
              <span class="member-face" aria-hidden="true">{{ initial(r.displayName) }}</span>
              <span class="grow member-main">
                <span class="member-name">
                  {{ r.displayName }}
                  <span v-if="r.roleBadge" class="badge badge-brand">{{ r.roleBadge }}</span>
                </span>
                <span class="member-tags">
                  <span class="badge" :class="r.linkClass">{{ r.linkLabel }}</span>
                  <span v-if="r.latencyText" class="mono member-tag">{{ r.latencyText }}</span>
                  <span class="mono member-tag">{{ r.virtualIp ?? '尚未分配地址' }}</span>
                  <span v-if="r.deviceName" class="member-tag">{{ r.deviceName }}</span>
                  <span v-if="r.lastSeen" class="member-tag">{{ r.lastSeen }}</span>
                </span>
              </span>
              <!-- 状态点只是个"一眼能扫"的辅助：文字在链路徽标里，颜色不单独承载信息 -->
              <span class="led" :class="r.dotClass" :title="r.linkLabel" />
              <template v-if="isHost">
                <template v-if="r.status === 'pending'">
                  <button class="btn btn-sm" type="button" @click="approveMember(r.userId, true)">通过</button>
                  <button class="btn btn-sm btn-ghost" type="button" @click="approveMember(r.userId, false)">拒绝</button>
                </template>
                <button
                  v-else-if="r.role !== 'host'"
                  class="btn btn-sm btn-danger"
                  type="button"
                  :disabled="busy"
                  @click="doKick(r.userId, r.displayName)"
                >
                  踢出
                </button>
              </template>
            </div>
          </div>
          <p v-else class="hint">还没有其他成员。把右栏的加入码和联机地址发给朋友就行。</p>

          <p v-if="isHost" class="hint">
            踢人后服务端会重算房间 ACL（按被踢成员的虚拟 IP 建丢弃规则），本客户端的 easytier-core 会自动应用。
          </p>
        </section>

        <!-- 连接路径：easytier-cli 的输出是按路径列的，必须清洗 + 分组后再铺（见 visiblePeers） -->
        <section class="card stack">
          <div class="section-head">
            <span class="title">连接路径</span>
            <span class="grow" />
            <span class="faint" style="font-size: var(--fs-xs)">
              {{ visiblePeers.length > 0 ? `${visiblePeers.length} 条` : '暂无' }}
            </span>
          </div>

          <!--
            丢包提示：一句话结论 + 一个动作（用户明确要求，不在这里解释内部机制）。
            放在**分组之上**：这一栏里其它东西都是"读一眼"，只有它是"要做点什么"，
            而玩家的窗口本来就常常是被切出去看一眼再切回来的（见 PRODUCT.md），
            埋在两张分组表下面等于没人看见。已经走中继时不再出现。

            判据是「本机 → 房主」那条链路，**不是**"任意 cost = p2p 的节点"：
            本机到平台中继节点往往也是直连，按 cost 判定就会在"房间里全是中继节点"时
            误报 P2P 丢包（用户实测截图）。房主本人看不到这条提示 ——
            他没有"到房主"的链路，同一个位置换成一句"这项不适用"的说明，
            而不是留一个永远为空的指标。
          -->
          <div v-if="lossTipVisible" class="alert alert-warn loss-tip">
            <span class="grow">到房主的直连在丢包（{{ formatLoss(hostLoss) }}）。</span>
            <button class="btn btn-sm" type="button" :disabled="relayDisabled" @click="doToggleRelay()">
              强制走中继
            </button>
          </div>
          <p v-else class="hint host-link-note">{{ hostLinkNote }}</p>

          <template v-if="visiblePeers.length > 0">
            <!-- 房间成员：这里才是"我和谁连上了、是直连还是绕路" -->
            <div v-if="memberPeers.length > 0" class="path-group">
              <div class="path-group-head">
                <span class="path-group-title">房间成员</span>
                <span class="faint">{{ memberPeers.length }}</span>
              </div>
              <div class="roster">
                <div v-for="p in memberPeers" :key="`m-${p.ipv4}${p.hostname}`" class="roster-row">
                  <span class="grow roster-main">
                    <span class="roster-name">{{ p.hostname || '未命名节点' }}</span>
                    <span class="roster-sub">{{ p.ipv4 || '—' }}</span>
                  </span>
                  <span class="badge" :class="p.cost.startsWith('p2p') ? 'badge-ok' : 'badge-neutral'">
                    {{ p.cost.startsWith('p2p') ? 'P2P 直连' : '经中继' }}
                  </span>
                  <span class="mono faint roster-sub roster-num">
                    {{ p.latencyMs === null ? '—' : `${p.latencyMs.toFixed(1)} ms` }}
                  </span>
                  <span
                    class="mono faint roster-sub roster-num"
                    :class="{ 'loss-high': isHighLoss(p) }"
                    :title="lossTitle(p)"
                  >
                    丢包 {{ formatLoss(p.lossRate) }}
                  </span>
                  <span class="mono faint roster-sub roster-num">{{ formatBytes(p.rxBytes + p.txBytes) }}</span>
                </div>
              </div>
            </div>

            <!--
              两个槽位的角色（主控 `RoomService.pickRoomRelays`）：票据 relays[0] = 打洞节点
              （协调 P2P 打洞，**不承载数据**），relays[1] = 中继节点（真正转发房间流量）。
              两台平时都连着（保活），所以不能靠"有没有字节"来判断谁在用 —— 按票据顺序标角色。
            -->
            <div v-if="relayPeers.length > 0" class="path-group">
              <div class="path-group-head">
                <span class="path-group-title">中继节点</span>
                <span class="faint">{{ relayPeers.length }}</span>
              </div>
              <div class="roster">
                <div v-for="p in relayPeers" :key="`r-${p.ipv4}${p.hostname}`" class="roster-row">
                  <span class="grow roster-main">
                    <span class="roster-name">{{ p.hostname || '未命名中继' }}</span>
                    <!--
                      认不出角色时把票据里的名字显示出来（见 relayNameHint 的注释）：
                      "内核报的名字" 与 "票据里的名字" 摆在一起，一眼能看出差在哪。
                    -->
                    <span v-if="relayRole(p) === null" class="roster-sub">{{ relayNameHint }}</span>
                    <span v-else class="roster-sub">{{ p.ipv4 || '平台下发的中继入口' }}</span>
                  </span>
                  <span
                    v-if="relayRole(p) === 'punch'"
                    class="badge badge-neutral"
                    title="打洞节点：协助两端打洞（交换公网地址），不承载房间流量"
                  >
                    打洞节点
                  </span>
                  <span
                    v-else-if="relayRole(p) === 'relay'"
                    class="badge badge-ok"
                    title="中继节点：打不通 P2P 时，房间流量走这一台"
                  >
                    中继节点
                  </span>
                  <!-- 名字对不上（例如节点改名/老主控）：宁可不标角色，也不标错 -->
                  <span
                    v-else
                    class="badge badge-neutral"
                    :title="`认不出这台是打洞节点还是中继节点：内核报的 hostname 是「${p.hostname}」，${relayNameHint}`"
                  >
                    角色未知
                  </span>
                  <span class="mono faint roster-sub roster-num">
                    {{ p.latencyMs === null ? '—' : `${p.latencyMs.toFixed(1)} ms` }}
                  </span>
                  <span
                    class="mono faint roster-sub roster-num"
                    :class="{ 'loss-high': isHighLoss(p) }"
                    :title="lossTitle(p)"
                  >
                    丢包 {{ formatLoss(p.lossRate) }}
                  </span>
                  <span class="mono faint roster-sub roster-num">{{ formatBytes(p.rxBytes + p.txBytes) }}</span>
                </div>
              </div>
            </div>
          </template>
          <p v-else class="hint">还没有发现其它节点。等成员进来后这里会显示他们。</p>
        </section>

        <!-- 房间聊天：放在成员下面，和"谁在场"挨着 -->
        <ChatPanel />
      </div>

      <!-- ================================================= 右栏：房间本身与我的动作 -->
      <aside class="room-side">
        <!-- 房间卡：名字 / 加入码 / 联机地址 / 全部动作 -->
        <section class="card stack">
          <div class="room-card-head">
            <h2 class="room-title">{{ room.name }}</h2>
            <button
              class="icon-btn"
              :class="{ 'is-on': favorite }"
              type="button"
              :title="favorite ? '取消收藏' : '收藏这个房间'"
              :aria-label="favorite ? '取消收藏' : '收藏这个房间'"
              @click="toggleFav()"
            >
              <svg viewBox="0 0 14 14" aria-hidden="true">
                <path d="M7 1.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L7 10.1l-3.4 1.8.7-3.8L1.5 5.5l3.8-.5z" />
              </svg>
            </button>
          </div>

          <!-- 加入码：整行可点即复制（和联机地址一样，是"发出去"的东西） -->
          <button class="code-row" type="button" title="点击复制加入码" @click="copy(room.code, 'code')">
            <span class="code-label">加入码</span>
            <span class="code-value mono">{{ room.code }}</span>
            <span class="code-act">{{ copied === 'code' ? '已复制' : '复制' }}</span>
          </button>

          <div class="room-facts">
            <!-- 连接状态：圆点 + 文字（颜色不单独承载状态，这是本仓库的硬规则） -->
            <span class="link-state">
              <span class="led" :class="isOnline ? 'led-ok led-live' : 'led-signal'" />
              <span>{{ isOnline ? '虚拟网络已连接' : '正在建立连接…' }}</span>
            </span>
            <span>区域 {{ regionLabel(room.zone) }}</span>
            <span>网段 <span class="mono">{{ room.subnet }}</span></span>
            <span>在线 <span class="mono">{{ room.onlineMembers }}/{{ room.policy.maxPlayers }}</span></span>
          </div>

          <!--
            联机地址：整块可点即复制 —— 这是本产品最核心的一个动作，所以它仍然独占一块强调色。
            下面只留一行"点一下即复制"：端口怎么写属于"按游戏查"的资料，
            全在「联机帮助」里，房间里不再出现解释性长句。
          -->
          <button
            class="addr-copy"
            type="button"
            :disabled="!shareAddress"
            title="点击复制联机地址"
            @click="copyAddress()"
          >
            <span class="addr-label">联机地址</span>
            <span class="addr-value">{{ shareAddress ?? '等待分配…' }}</span>
            <span class="addr-hint">{{ copied === 'addr' ? '已复制到剪贴板' : '点一下即复制' }}</span>
          </button>

          <!--
            动作区：房主操作就在这儿（不再单独占页面底部一段）。
            每个按钮都带文字与 title：房间规则 / 轮换密钥这种词，只给图标没人猜得出来。
            破坏性动作（关闭房间 / 退出房间）占整行并走确认弹层。
          -->
          <div class="room-acts">
            <button
              class="btn btn-sm"
              type="button"
              title="分享地址：把加入码、联机地址和进房步骤一起复制给朋友"
              @click="inviteOpen = true"
            >
              分享地址
            </button>
            <button
              class="btn btn-sm"
              type="button"
              title="刷新状态：重新读一次节点、链路与延迟"
              :disabled="busy"
              @click="pollPeers()"
            >
              刷新状态
            </button>
            <template v-if="isHost">
              <button
                class="btn btn-sm"
                type="button"
                title="房间规则：人数上限、带宽与包速率限制、端口白名单、P2P 与局域网广播"
                @click="openPolicy()"
              >
                房间规则
              </button>
              <button
                class="btn btn-sm"
                type="button"
                title="轮换密钥：所有人（包括你）都会断开，需要用新的加入码重进"
                :disabled="busy"
                @click="doRotate()"
              >
                轮换密钥
              </button>
              <button
                class="btn btn-sm btn-danger"
                type="button"
                title="关闭房间：解散这个虚拟网络，所有成员立刻断开"
                :disabled="busy"
                @click="doClose()"
              >
                关闭房间
              </button>
            </template>
            <button
              v-else
              class="btn btn-sm btn-danger"
              type="button"
              title="退出房间：断开虚拟网络，想再进来要重新输入加入码"
              :disabled="busy"
              @click="doLeave()"
            >
              退出房间
            </button>

            <!--
              「强制走中继」占整行：它是这一族里唯一**改变链路怎么走**的动作，
              和"分享地址/刷新状态"这种读一读、发一发不是一件事。挤在半个格子里
              会让它看起来同样无关紧要（参照稿的动作胶囊也是把主次分开的）。
              `aria-pressed` 让读屏软件知道它是个开关，而不是一个普通的动作按钮。
            -->
            <button
              class="btn btn-sm relay-toggle"
              :class="{ 'is-on': relayMode === 'on', 'is-locked': relayMode === 'policy' }"
              type="button"
              :aria-pressed="relayMode === 'on' || relayMode === 'policy'"
              :title="relayTitle"
              :disabled="relayDisabled"
              @click="doToggleRelay()"
            >
              <span v-if="relayMode === 'switching'" class="spinner" />
              <span>{{ relayLabel }}</span>
            </button>
          </div>

          <div v-if="relayStateText" class="relay-state">
            <span class="led" :class="relayLedClass" aria-hidden="true" />
            <span class="grow">{{ relayStateText }}</span>
          </div>
        </section>

        <!--
          联机帮助入口：**整行**放在「我的网络」上面（用户指定位置与样式）。
          为什么是整行而不是动作区里的一个按钮：它不是"下一步做什么"，是"查资料"，
          跟分享/刷新不是一类动作；整行有标题 + 一行说明，玩家一眼看出里面有东西可查。
          按游戏查端口的那份表有 9 个游戏、每个 4~6 行，铺在页面上会占掉一整屏，
          所以只留这一行入口，内容进二级菜单。
        -->
        <button class="help-entry" type="button" @click="helpOpen = true">
          <span class="help-mark" aria-hidden="true">
            <svg viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="6.4" />
              <path d="M6.1 6.1a1.95 1.95 0 1 1 2.6 1.84c-.5.2-.7.6-.7 1.06v.4" />
              <path d="M8 12.05v.05" />
            </svg>
          </span>
          <span class="grow help-entry-text">
            <span class="help-entry-title">联机帮助</span>
            <span class="help-entry-sub">按游戏查房主要做什么、玩家填什么（要不要带端口）</span>
          </span>
          <span class="help-entry-more" aria-hidden="true">
            <svg viewBox="0 0 16 16">
              <path d="M6 3.6l4.4 4.4L6 12.4" />
            </svg>
          </span>
        </button>

        <!-- 我这边的读数 -->
        <section class="card stack">
          <div class="section-head">
            <span class="title">我的网络</span>
            <span class="grow" />
            <span class="badge badge-neutral mono">{{ session.virtualIp }}</span>
          </div>

          <div class="stat-row">
            <div>
              <div class="stat-label">下载</div>
              <div class="stat-value">{{ formatBitrate(clientState.localRxBps) }}</div>
            </div>
            <div>
              <div class="stat-label">上传</div>
              <div class="stat-value">{{ formatBitrate(clientState.localTxBps) }}</div>
            </div>
            <div>
              <div class="stat-label">累计流量</div>
              <div class="stat-value">{{ formatBytes(clientState.localRxBytes + clientState.localTxBytes) }}</div>
            </div>
          </div>
        </section>

        <!--
          连接诊断：默认收起（入口一整行可点）。
          展开时才挂载组件 —— 它要调两次 easytier-cli，进房后还要等 5 秒才出数，
          常驻展开等于每次进房都白等一遍、还占掉右栏一大块。
        -->
        <button class="help-entry" type="button" :aria-expanded="diagOpen" @click="diagOpen = !diagOpen">
          <span class="help-mark" aria-hidden="true">
            <svg viewBox="0 0 16 16">
              <path d="M1.6 8.4h2.6l1.5-4.6 2.3 8.6 1.8-4h4.6" />
            </svg>
          </span>
          <span class="grow help-entry-text">
            <span class="help-entry-title">连接诊断</span>
            <span class="help-entry-sub">P2P 还是中继、延迟、NAT 与监听端口</span>
          </span>
          <span class="help-entry-more" aria-hidden="true">{{ diagOpen ? '收起' : '展开' }}</span>
        </button>
        <ConnectionDiagnostic v-if="diagOpen" />
      </aside>
    </div>

    <!-- 联机帮助二级菜单：按游戏查「房主做什么 / 玩家填什么」 -->
    <div v-if="helpOpen" class="modal-mask" @click.self="helpOpen = false">
      <div class="card modal-card help-modal stack">
        <div class="row-between">
          <div>
            <div class="modal-title">联机帮助</div>
            <div class="hint">
              按游戏查「房主要做什么、玩家填什么地址」。要不要带端口、端口是多少，每个游戏里都写着；
              列表里的地址已经带好端口，点一下就复制。
            </div>
          </div>
          <button class="icon-btn" type="button" title="关闭帮助" aria-label="关闭帮助" @click="helpOpen = false">
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3.4 3.4l7.2 7.2M10.6 3.4l-7.2 7.2" />
            </svg>
          </button>
        </div>
        <GameQuickConnect />
      </div>
    </div>

    <!-- 邀请信息弹层：多行文本，可直接粘到群里 -->
    <div v-if="inviteOpen" class="modal-mask">
      <div class="card modal-card stack">
        <div style="font-weight: 650; font-size: var(--fs-lg)">邀请信息</div>
        <div class="hint">下面这段可以直接复制粘贴到 QQ / 微信群里，朋友照着做就能进来。</div>
        <pre class="invite mono">{{ inviteText }}</pre>
        <div class="row">
          <button class="btn btn-primary grow" @click="copy(inviteText, 'invite')">
            {{ copied === 'invite' ? '已复制到剪贴板' : '复制邀请信息' }}
          </button>
          <button class="btn btn-ghost" @click="inviteOpen = false">关闭</button>
        </div>
        <div class="hint">
          加入码可以进房间，联机地址用于游戏内直连；两者都不是长期凭证 ——
          房主轮换密钥或关闭房间后就失效了。
        </div>
      </div>
    </div>

    <!-- 房间规则弹层 -->
    <div v-if="policyOpen" class="modal-mask">
      <div class="card modal-card stack">
        <div style="font-weight: 650; font-size: var(--fs-lg)">房间规则</div>
        <div class="grid-2" style="gap: 12px">
          <div class="field">
            <label class="label">最大人数</label>
            <input v-model.number="policy.maxPlayers" class="input" type="number" min="2" max="64" />
          </div>
          <div class="field">
            <label class="label">允许 P2P 直连</label>
            <select v-model="policy.allowP2p" class="select">
              <option :value="true">允许（延迟更低，省中转带宽）</option>
              <option :value="false">禁止（一律走中继）</option>
            </select>
          </div>
        </div>
        <div class="grid-2" style="gap: 12px">
          <div class="field">
            <label class="label">房间总带宽上限（kbps，0 = 不限）</label>
            <input v-model.number="policy.maxBandwidthKbps" class="input" type="number" min="0" />
            <div class="hint">作用于房主实例的接收限速，约束整个房间的上行入口。</div>
          </div>
          <div class="field">
            <label class="label">单成员接收上限（kbps，0 = 不限）</label>
            <input v-model.number="policy.perMemberKbps" class="input" type="number" min="0" />
            <div class="hint">由各成员本地实例执行；恶意客户端可绕过，仅作正常限速。</div>
          </div>
        </div>
        <div class="grid-2" style="gap: 12px">
          <div class="field">
            <label class="label">包速率上限（包/秒，0 = 不限）</label>
            <input v-model.number="policy.rateLimitPps" class="input" type="number" min="0" />
            <div class="hint">EasyTier 的 ACL 限速单位是包/秒，不是带宽。</div>
          </div>
          <div class="field">
            <label class="label">游戏端口白名单</label>
            <input v-model="policy.allowedPorts" class="input" placeholder="例如 25565 或 25565-25570" />
          </div>
        </div>
        <div class="field">
          <label class="label">严格端口模式</label>
          <select v-model="policy.strictPorts" class="select">
            <option :value="false">关闭（默认放行，只做踢人与限速）</option>
            <option :value="true">开启（默认丢弃，只放行白名单端口与 ICMP）</option>
          </select>
        </div>
        <!--
          局域网广播直通：默认关闭。
          EasyTier 自己也是默认关的 —— 它靠 WinDivert 内核网络过滤驱动去抓物理网卡的
          UDP 广播，而驱动路径就是我们 vendored 的那份，实测会让部分机器上其它软件断网。
          所以这是个"要就自己开"的能力，代价必须写在开关下面，而不是藏在文档里。

          **Windows 专属**：WinDivert 是 Windows 的驱动，macOS 上这套抓包/重放根本不存在。
          所以非 Windows 上这个下拉框直接置灰 —— 置灰而不是隐藏：玩家看得见"平台没有这个能力"，
          比到处找不到这个选项更好懂；说明文字也写清了替代做法（直接连接 + 房间地址）。
        -->
        <div class="field">
          <label class="label">局域网广播直通</label>
          <select v-model="policy.allowBroadcast" class="select" :disabled="!supportsLanBroadcast">
            <option :value="false">关闭（推荐）</option>
            <option :value="true">开启（局域网列表可见）</option>
          </select>
          <div v-if="!supportsLanBroadcast" class="hint">
            当前平台不支持（{{ platformLabel }}）：它靠 Windows 的 WinDivert 内核驱动抓物理网卡的 UDP 广播，
            macOS 上没有这个驱动，所以这一项在这里既不能开、也不会被这次保存改动。
            用「直接连接 + 房间地址」照常联机 —— 房间卡上的地址可以一键复制。
          </div>
          <div v-else class="hint">
            开启后 Minecraft「多人游戏」列表能直接看到房间，不用手输 IP。代价：Windows 上会安装一个系统级网络过滤驱动（WinDivert）来抓 UDP
            广播，部分软件（如网易云音乐）可能因此上不了网。关闭时用「直接连接 + 虚拟地址」照常联机。
          </div>
        </div>
        <div class="row">
          <button class="btn btn-primary grow" :disabled="busy" @click="savePolicy">保存并生效</button>
          <button class="btn btn-ghost" @click="policyOpen = false">取消</button>
        </div>
        <div class="hint">
          保存后服务端会重算 ACL 并推送；本客户端优先热更新，若当前 EasyTier 版本不支持则重启实例（约 2 秒）。
        </div>
        <button class="btn btn-ghost btn-sm" @click="applyHostAclIfNeeded(true)">立即重新应用规则</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ 两栏骨架 */
/*
 * `width: 100%` 不是多余的：`.view` 自带 `margin: 0 auto`，而它在 `.deck-scroll`
 * 这个**纵向 flex 容器**里 —— 带 auto 外边距的 flex 项不会被 stretch，宽度会退化成
 * fit-content。写死 100% 之后两栏的宽度才是确定的（940 窗口实测 537 / 269）。
 */
.room-view {
  width: 100%;
}

/*
 * 两栏是**这一页自己**的栅格，所以它必须通栏：
 * styles.css 在 ≥740px 时已经把 `.room-view` 排成了两等分栅格，
 * 这层内层栅格是它的一个整体（不通栏就会被塞进其中一格）。
 */
.room-columns {
  grid-column: 1 / -1;
  display: grid;
  /* fr 分配的是整条轨道，所以两栏宽度比恒为 2:1，不随窗口变化漂移 */
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: var(--s-4);
  align-items: start;
  min-width: 0;
}
.room-main,
.room-side {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  min-width: 0;
}
/*
 * 窄于 820 回落一栏：图标栏吃掉 80 之后，1/3 侧栏只剩 236px，
 * 房间卡的两个按钮会开始竖着叠、成员行的标签也会挤成两行。
 * 断点取 820 而不是窗口最小值 780 —— 780 时两栏已经不能读了。
 */
@media (max-width: 819px) {
  .room-columns {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* -------------------------------------------------------------------- 成员行 */
/*
 * 行与行之间只隔一条发丝线：成员卡里再给每行套一张小卡，就是"卡里套卡"，
 * 而且行数一多整张卡会碎成一堆盒子。
 */
.member-list {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.member {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: 9px 0;
  min-width: 0;
}
.member + .member {
  border-top: 1px solid var(--line-soft);
}
/* 暖色单调圆 + 首字母：不需要任何素材，也不假装有插画（参照稿的头像形态） */
.member-face {
  flex: none;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--accent-wash);
  color: var(--accent);
  font-size: var(--fs-sm);
  font-weight: 650;
}
.member-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.member-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  color: var(--ink);
  font-size: var(--fs-sm);
  font-weight: 600;
}
.member-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 6px;
  min-width: 0;
}
.member-tag {
  color: var(--ink-3);
  font-size: var(--fs-xs);
  overflow-wrap: anywhere;
}

/* ---------------------------------------------------------------- 右栏房间卡 */
.room-card-head {
  display: flex;
  align-items: flex-start;
  gap: var(--s-2);
}
/*
 * 不用 styles.css 里的 `.room-name`：那条规则是 0,2,0 且在这里要改字号，
 * 同特异性比的是打包顺序 —— 换个新类名就没这个不确定性。
 */
.room-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: var(--track-display);
  line-height: var(--lh-tight);
  overflow-wrap: anywhere;
}

/* 加入码：整行可点即复制 */
.code-row {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  width: 100%;
  padding: 6px var(--s-3);
  border: 0;
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: copy;
  transition: background var(--dur-fast) var(--ease);
}
.code-row:hover {
  background: var(--surface-3);
}
.code-label {
  color: var(--ink-3);
  font-size: var(--fs-xs);
}
.code-value {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-lg);
  font-weight: 650;
  letter-spacing: var(--track-wide);
  overflow-wrap: anywhere;
}
.code-act {
  flex: none;
  color: var(--accent);
  font-size: var(--fs-xs);
  font-weight: 600;
}

.room-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px var(--s-2);
  color: var(--ink-3);
  font-size: var(--fs-xs);
}
/* 连接状态整行独占（它比区域/网段重要一档），圆点与文字基线对齐 */
.link-state {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-basis: 100%;
  color: var(--ink-2);
}

/* 路径行里的数字不折行：折了以后 ms 与字节数会各自换行，两行错位看不出是哪条路径的 */
.roster-num {
  white-space: nowrap;
}

/* 联机地址铭牌：保留强调色底（这是整页唯一带强调色的东西），但收成一行 */
.addr-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: var(--s-3);
  border: 1px solid var(--signal-line);
  border-radius: var(--r-md);
  background: var(--signal-wash);
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: copy;
}
.addr-copy:hover:not(:disabled) .addr-value {
  color: var(--accent-strong);
}
.addr-copy:disabled {
  cursor: not-allowed;
}

/*
 * 动作区：两列网格。可用宽度只有 ~245px，所以按钮内边距收一档；
 * 破坏性动作占整行 —— 它是最重的一个，不该和"刷新状态"一样宽。
 *
 * 类名为什么叫 room-acts 而不是 room-actions：styles.css 里有一个**同名**的
 * `.app-shell .room-actions`（旧单列布局的图标行，`display:flex` 且不换行），
 * 与本文件的 scoped 规则同特异性（0,2,0），比的是打包顺序 —— 实测打包版里
 * 就是那条旧规则赢，五个按钮挤成一行、从卡片右边溢了出去。
 * 换个没被占用的名字比"比特异性"稳，也比删别人文件里的规则安全。
 */
.room-acts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.room-acts .btn {
  padding-inline: var(--s-2);
}
.room-acts .btn-danger {
  grid-column: 1 / -1;
}

/*
 * 强制走中继：整行，且"已开启"有**静态**的形（浅强调底 + 强调色字 + 描边），
 * 不是只靠颜色闪一下 —— 颜色不单独承载状态是本仓库的硬规则。
 * 描边用 --accent-soft（非文字专用色）而不是 --accent：这一圈只是"选中"的形，
 * 不是要读的字，压白卡当装饰线正好（当文字用会过不了 AA）。
 */
.relay-toggle {
  grid-column: 1 / -1;
}
.relay-toggle.is-on {
  background: var(--accent-wash);
  border-color: var(--accent-soft);
  color: var(--accent);
}
.relay-toggle.is-on:hover:not(:disabled) {
  background: var(--accent-wash);
  border-color: var(--accent);
  color: var(--accent-strong);
}
/*
 * 只读态（房主在房间规则里让全房间走中继）必须**照实显示"在中继上"**。
 *
 * styles.css 的 `.btn:disabled { opacity: .5 }` 会把这个状态淡成"没开"的样子 ——
 * 而它恰恰是"已经走中继"，读反了玩家就会以为房间里没人走中继。禁用是为了不让点
 * （点了也不生效），不是为了让状态变模糊；所以这里把不透明度拉回来，并保留
 * "开"的形（浅强调底 + 强调色字）。本文件的选择器是 0,3,0，压得住那条 0,2,0。
 */
.relay-toggle.is-locked {
  opacity: 1;
  cursor: not-allowed;
  background: var(--accent-wash);
  border-color: var(--accent-soft);
  color: var(--accent);
}

/*
 * 切换结果/当前链路决策：与账号卡里那几段同一手法 —— 一条发丝线 + 字号降一档，
 * 不套小卡片（契约禁止卡里套卡）。文字允许换行，窄窗里不会被切掉半句。
 */
.relay-state {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding-top: var(--s-3);
  border-top: 1px solid var(--line-soft);
  color: var(--ink-3);
  font-size: var(--fs-xs);
  text-wrap: pretty;
  min-width: 0;
}

/* ------------------------------------------------------------ 丢包读数与提示 */
/*
 * 高出阈值的丢包：加深 + 加粗 + title。数字本身就是文字通道（丢包 5.3% / 丢包 0.0%），
 * 颜色只做强化；动作写在下面那条提示里，不指望玩家自己从颜色里读出该干什么。
 *
 * ⚠️ 选择器必须是 `.roster-row .loss-high`（0,3,0），不能只写 `.loss-high`。
 * 这一行同时带着 `.roster-sub`，而 styles.css 里那条 `.app-shell .roster-sub`
 * 也是 0,2,0 —— **实测打包产物里 styles.css 排在 SFC 样式之后**，
 * 于是同特异性比打包顺序，颜色被它盖掉：屏幕上看到的是普通的灰（--paper-faint），
 * 只有字重变成 600（那条属性没人和我抢）。加一层 `.roster-row` 就稳定赢，
 * 不用 !important 也不用去改别人文件里的规则。
 */
.roster-row .loss-high {
  color: var(--warn);
  font-weight: 600;
}

/* 提示条：一句话结论 + 一个动作。用 .alert alert-warn 的既有语义色，不新造一层皮 */
.loss-tip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--s-2);
}

/*
 * 「到房主」那一行说明：提示条不出现时它就在同一个位置。
 * 把"这一次判定看的是哪条链路"直接写出来（房主看到的是"这项不适用"），
 * 所以它不能是一个空指标 —— 四种情况（房主本人 / 还没有房主节点 /
 * 到房主走中继 / 到房主直连）都有各自的一句话。
 * 尺寸与颜色沿用 .hint 那一档，只把段落外边距收掉，避免在 .stack 里多出一段空隙。
 */
.host-link-note {
  margin: 0;
}

/* ------------------------------------------------------------------ 帮助入口 */
.help-entry {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  width: 100%;
  min-width: 0;
  padding: var(--s-3);
  border: 0;
  border-radius: var(--r-lg);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--ink);
  font-family: var(--font-ui);
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.help-entry:hover {
  background: var(--surface-2);
}
.help-mark {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: var(--r-sm);
  background: var(--accent-wash);
  color: var(--accent);
}
.help-mark svg,
.help-entry-more svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.help-entry-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.help-entry-title {
  font-size: var(--fs-sm);
  font-weight: 650;
}
.help-entry-sub {
  font-size: var(--fs-xs);
  color: var(--ink-3);
  line-height: var(--lh-snug);
}
.help-entry-more {
  flex: none;
  display: grid;
  place-items: center;
  color: var(--ink-faint);
}

/* -------------------------------------------------------------------- 弹层 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: grid;
  place-items: center;
  padding: var(--s-5);
  z-index: 300;
}
.modal-card {
  width: min(560px, 100%);
  max-height: 88vh;
  overflow: auto;
}
/* 帮助弹层比房间规则宽一档：里面是「游戏名 + 两步说明 + 地址」的长文本 */
.help-modal {
  width: min(660px, 100%);
}
.modal-title {
  color: var(--ink);
  font-weight: 650;
  font-size: var(--fs-lg);
}
.invite {
  margin: 0;
  padding: var(--s-3);
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--well);
  font-size: var(--fs-sm);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
</style>
