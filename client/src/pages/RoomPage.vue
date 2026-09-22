<script setup lang="ts">
/**
 * 房间页 —— 进房后的主界面。
 *
 * 排布逻辑：**先把要发出去的东西放最上面，再放"我自己"的读数，然后才是别人。**
 * 玩家进房后 90% 的动作是「把联机地址发给朋友」，所以地址是整页唯一带强调色的
 * 一块，而且整块可点即复制；房间名与关键信息挤在它上面一行，房主操作收到页面
 * 最底部单独一段 —— 关房间这种事不该和"复制地址"抢同一个位置。
 *
 * 成员与节点用发丝线分隔的名册，而不是卡片套卡片：窄窗里每多一层盒子，
 * 就少一行能看的信息。
 */
import { computed, onUnmounted, ref } from 'vue';
import { formatBitrate, formatBytes, regionLabel } from '@mclink/shared';
import {
  applyHostAclIfNeeded,
  approveMember,
  clientState,
  closeRoom,
  isHost,
  isOnline,
  kickMember,
  leaveRoom,
  pollPeers,
  refreshRoom,
  rotateSecret,
  shareAddress,
  updateRoomPolicy,
} from '../lib/store.ts';
import type { PeerView } from '../lib/easytier-parse.ts';
import { friendlyError } from '../lib/api.ts';
import { copyText } from '../lib/clipboard.ts';
import { isFavorite, shortcutsRevision, toggleFavorite } from '../lib/shortcuts.ts';
import ChatPanel from '../components/ChatPanel.vue';
import ConnectionDiagnostic from '../components/ConnectionDiagnostic.vue';
import GameQuickConnect from '../components/GameQuickConnect.vue';

const copied = ref('');
const busy = ref(false);
const error = ref('');
const policyOpen = ref(false);
const inviteOpen = ref(false);
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
 *   3. **按「房间成员 / 中继节点」分组** —— 这是玩家最容易误解的地方：平台会下发多个中继
 *      （主控 + 各区域子节点），它们各占一行，看起来像"我同时连了两台服务器"。
 *      实际只有一个承载业务流量，其余是冗余与打洞协助。分组 + 「备用」标注把这个事实
 *      直接讲清楚，而不是让玩家自己猜。
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
/** 走过流量的路径才算"在用"：只有字节数能说明哪条真的承载了业务流量 */
const carriesTraffic = (p: PeerView): boolean => p.rxBytes + p.txBytes > 0;

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
      allowBroadcast: policy.value.allowBroadcast,
    });
    policyOpen.value = false;
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}

async function doKick(userId: string, name: string): Promise<void> {
  const ok = await window.mclink.confirm({
    title: '踢出成员',
    message: `确定把「${name}」移出房间吗？`,
    detail: '对方会立即断开虚拟网络。房主的 EasyTier 实例可能需要短暂重连（约 2 秒）才能让规则生效。',
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
  const ok = await window.mclink.confirm({
    title: '轮换房间密钥',
    message: '轮换后所有成员（包括你自己）都会断开，需要用新的加入码信息重新进入。',
    detail: '网络名与密钥会一起更换，任何拿到过旧信息的人都将无法再连入。',
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
  const ok = await window.mclink.confirm({
    title: '关闭房间',
    message: '确定关闭房间吗？所有成员都会被断开。',
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
</script>

<template>
  <!-- room-view 让样式能按窗口宽度给这一页单独排版（见 styles.css 的响应式段） -->
  <div v-if="session && room" class="view room-view">
    <div v-if="error" class="alert alert-danger">{{ error }}</div>

    <!-- 房间头：名字 + 一行关键信息 + 一排方形动作按钮 -->
    <header class="room-head">
      <div class="room-title-row">
        <h2 class="room-name">{{ room.name }}</h2>
        <div class="room-actions">
          <button
            class="icon-btn"
            type="button"
            title="刷新状态"
            aria-label="刷新状态"
            :disabled="busy"
            @click="pollPeers()"
          >
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <path d="M1.3 7h2.4l1.5-4.2 2.1 8.4 1.6-4.2h3.8" />
            </svg>
          </button>
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
          <button class="icon-btn" type="button" title="邀请信息" aria-label="邀请信息" @click="inviteOpen = true">
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <path d="M5.6 8.4l2.8-2.8" />
              <path d="M6.3 3.9l1-1a2.3 2.3 0 0 1 3.2 3.2l-1 1" />
              <path d="M7.7 10.1l-1 1a2.3 2.3 0 0 1-3.2-3.2l1-1" />
            </svg>
          </button>
        </div>
      </div>

      <div class="room-meta">
        <span class="row" style="gap: 6px">
          <span class="led" :class="isOnline ? 'led-ok led-live' : 'led-signal'" />
          <span>{{ isOnline ? '虚拟网络已连接' : '正在建立连接…' }}</span>
        </span>
        <span>区域 {{ regionLabel(room.zone) }}</span>
        <span>网段 <span class="mono">{{ room.subnet }}</span></span>
        <span>在线 <span class="mono">{{ room.onlineMembers }}/{{ room.policy.maxPlayers }}</span></span>
        <button class="meta-copy" type="button" title="点击复制加入码" @click="copy(room.code, 'code')">
          加入码 {{ copied === 'code' ? '已复制' : room.code }}
        </button>
      </div>
    </header>

    <!-- 联机地址：整块可点，点一下就复制 -->
    <section class="addr">
      <button class="addr-hit" type="button" title="点击复制联机地址" @click="copyAddress()">
        <span class="addr-label">联机地址</span>
        <span class="addr-value">{{ shareAddress ?? '等待分配…' }}</span>
        <span class="addr-hint">点一下即复制；朋友在游戏里「多人游戏 → 直接连接」粘贴</span>
      </button>
      <button class="btn btn-primary" type="button" :disabled="!shareAddress" @click="copyAddress()">
        {{ copied === 'addr' ? '已复制' : '复制' }}
      </button>
    </section>

    <!-- 我这边的读数 -->
    <section class="panel">
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

    <!-- 连接路径：easytier-cli 的输出是按路径列的，必须清洗 + 分组后再铺（见 visiblePeers） -->
    <section class="panel">
      <div class="section-head">
        <span class="title">连接路径</span>
        <span class="grow" />
        <span class="faint" style="font-size: var(--fs-xs)">
          {{ visiblePeers.length > 0 ? `${visiblePeers.length} 条` : '暂无' }}
        </span>
      </div>

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
              <span class="mono faint roster-sub nowrap">
                {{ p.latencyMs === null ? '—' : `${p.latencyMs.toFixed(1)} ms` }}
              </span>
              <span class="mono faint roster-sub nowrap">{{ formatBytes(p.rxBytes + p.txBytes) }}</span>
            </div>
          </div>
        </div>

        <!-- 中继节点：平台下发的兜底入口。多个是刻意的冗余，不是"你连了两台服务器" -->
        <div v-if="relayPeers.length > 0" class="path-group">
          <div class="path-group-head">
            <span class="path-group-title">中继节点</span>
            <span class="faint">{{ relayPeers.length }}</span>
          </div>
          <div class="roster">
            <div v-for="p in relayPeers" :key="`r-${p.ipv4}${p.hostname}`" class="roster-row">
              <span class="grow roster-main">
                <span class="roster-name">{{ p.hostname || '未命名中继' }}</span>
                <span class="roster-sub">{{ p.ipv4 || '平台下发的中继入口' }}</span>
              </span>
              <!-- 只有走过字节数的那条才是在用的；其余显示"备用"，省得玩家以为流量走了两条 -->
              <span
                v-if="carriesTraffic(p)"
                class="badge badge-ok"
                title="这条路径承载了业务流量"
              >
                承载流量
              </span>
              <span v-else class="badge badge-neutral" title="冗余入口：只在主路径不可用时才转发">备用</span>
              <span class="mono faint roster-sub nowrap">
                {{ p.latencyMs === null ? '—' : `${p.latencyMs.toFixed(1)} ms` }}
              </span>
              <span class="mono faint roster-sub nowrap">{{ formatBytes(p.rxBytes + p.txBytes) }}</span>
            </div>
          </div>
          <p class="hint" style="margin-top: var(--s-2)">
            <template v-if="relayPeers.length > 1">
              这里有 {{ relayPeers.length }} 个中继，是刻意留的<strong>冗余</strong>：它们同时连着，用于协助打洞、
              以及某个中继不可用时顶上，但同一时刻只有一个在转发你的流量，所以不会叠加延迟 ——
              其余几条只有心跳流量（行尾的字节数就是证据）。
            </template>
            <template v-else>
              这是平台下发的中继入口：负责协助打洞，并在直连失败时转发你的流量。
              等两个玩家之间打通直连，数据会改走直连，它退成兜底。
            </template>
          </p>
        </div>
      </template>
      <p v-else class="hint">还没有发现其它节点。等成员进来后这里会显示他们。</p>
    </section>

    <!-- 成员名册 -->
    <section class="panel">
      <div class="section-head">
        <span class="title">房间成员</span>
        <span class="count mono">{{ members.length }}</span>
        <span class="grow" />
        <span v-if="pending.length > 0" class="badge badge-warn">{{ pending.length }} 个待审批</span>
      </div>

      <div v-if="members.length > 0" class="roster">
        <div v-for="m in members" :key="m.userId" class="roster-row">
          <span class="avatar">{{ initial(m.displayName) }}</span>
          <span class="grow roster-main">
            <span class="roster-name">{{ m.displayName }}</span>
            <span class="roster-sub">
              {{ m.virtualIp ?? '尚未分配地址' }}
              <!-- 掉线的人要说明"多久没心跳了"，否则玩家只看到在线数和人数对不上 -->
              <template v-if="m.lastSeenAt && isStale(m)"> · 最后心跳 {{ lastSeenText(m) }}</template>
            </span>
          </span>
          <span v-if="m.status === 'pending'" class="badge badge-warn">待审批</span>
          <span v-else-if="m.role === 'host'" class="badge badge-brand">房主</span>
          <!--
            离线判定优先于「直连/成员」：`p2p` 与 `latencyMs` 都是成员**上次心跳时**上报的值，
            心跳断了之后这些数字就不再代表当下（实测：掉线的人还挂着"直连 1 ms"）。
          -->
          <span v-else-if="isStale(m)" class="badge badge-warn">离线</span>
          <span v-else-if="m.p2p" class="badge badge-ok">直连</span>
          <span v-else class="badge badge-neutral">成员</span>
          <span v-if="!isStale(m) && m.latencyMs !== null" class="mono faint roster-sub nowrap">
            {{ `${m.latencyMs.toFixed(0)} ms` }}
          </span>
          <template v-if="isHost">
            <template v-if="m.status === 'pending'">
              <button class="btn btn-sm" type="button" @click="approveMember(m.userId, true)">通过</button>
              <button class="btn btn-sm btn-ghost" type="button" @click="approveMember(m.userId, false)">拒绝</button>
            </template>
            <button
              v-else-if="m.role !== 'host'"
              class="btn btn-sm btn-danger"
              type="button"
              :disabled="busy"
              @click="doKick(m.userId, m.displayName)"
            >
              踢出
            </button>
          </template>
        </div>
      </div>
      <p v-else class="hint">还没有其他成员。把上面的联机地址和加入码发给朋友就行。</p>

      <p v-if="isHost" class="hint">
        踢人后服务端会重算房间 ACL（按被踢成员的虚拟 IP 建丢弃规则），本客户端的 easytier-core 会自动应用。
      </p>
    </section>

    <!-- 房主操作单独收在底下：不和"发地址"抢同一行 -->
    <section class="panel">
      <div class="section-head">
        <span class="title">{{ isHost ? '房主操作' : '房间操作' }}</span>
      </div>
      <div class="ops">
        <template v-if="isHost">
          <button class="btn btn-sm" type="button" @click="openPolicy()">房间规则</button>
          <button class="btn btn-sm" type="button" :disabled="busy" @click="doRotate()">轮换密钥</button>
          <button class="btn btn-sm btn-danger" type="button" :disabled="busy" @click="doClose()">关闭房间</button>
        </template>
        <button v-else class="btn btn-sm btn-danger" type="button" :disabled="busy" @click="leaveRoom()">
          退出房间
        </button>
      </div>
      <p class="hint">
        {{ isHost
          ? '轮换密钥会让所有人断开并用新的凭证重进；关闭房间则直接解散这个虚拟网络。'
          : '退出后会断开虚拟网络；重新进入需要再输一次加入码。' }}
      </p>
    </section>

    <!-- 房间聊天 -->
    <ChatPanel />

    <!-- 按游戏查「房主做什么 / 玩家填什么」 -->
    <GameQuickConnect />

    <!-- 直连还是中继、延迟、NAT 与监听端口 -->
    <ConnectionDiagnostic />

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
        -->
        <div class="field">
          <label class="label">局域网广播直通</label>
          <select v-model="policy.allowBroadcast" class="select">
            <option :value="false">关闭（推荐）</option>
            <option :value="true">开启（局域网列表可见）</option>
          </select>
          <div class="hint">
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
