<script setup lang="ts">
/**
 * 仪表盘：平台概览 + 节点/房间速览 + 审计时间线。
 *
 * 数据只来自 `/admin/overview`：
 *   - `nodes` / `rooms` 是**计数对象**（状态分布、开放房间数、在线玩家数）；
 *   - `recentNodes` / `recentRooms` 是「前 12」列表，用于两张速览表格。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  Routes,
  Topics,
  formatBitrate,
  formatDuration,
  formatRelativeTime,
  regionLabel,
  type AuditEntry,
  type RelayNode,
  type Room,
  type ServerEvent,
} from '@mclink/shared';
import { api, friendlyError } from '../../lib/api.ts';
import { RealtimeClient } from '../../lib/realtime.ts';
import {
  asArray,
  asStringList,
  formatDateTime,
  nodeLabel,
  nodeTone,
  roomLabel,
  roomTone,
} from '../../lib/ui.ts';
import StatCard from '../../components/StatCard.vue';
import Badge from '../../components/Badge.vue';

interface NodeCounts {
  total: number;
  online: number;
  degraded: number;
  offline: number;
  pending: number;
}

interface RoomCounts {
  open: number;
  total: number;
  onlinePlayers: number;
}

interface AdminOverview {
  serverTime: string;
  version: string;
  easytierVersion: string | null;
  uptimeSeconds: number;
  nodes: NodeCounts;
  rooms: RoomCounts;
  users: { total: number; online: number };
  /** rxBps/txBps 是全网聚合；转发全在子节点上，master* 恒为 0（字段仍在，老前端不白屏） */
  traffic: {
    rxBps: number;
    txBps: number;
    rxBytesToday: number;
    txBytesToday: number;
    masterRxBps: number;
    masterTxBps: number;
    nodesRxBps: number;
    nodesTxBps: number;
    onlineRelayNodes: number;
  };
  system: {
    nodeVersion: string;
    platform: string;
    schemaVersion: number | string;
    dbFile: string;
    pid: number;
    memoryMb: number;
  };
  recentNodes: RelayNode[];
  recentRooms: Room[];
  recentAudit: AuditEntry[];
  warnings: string[];
}

const overview = ref<AdminOverview | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  try {
    overview.value = await api.get<AdminOverview>(Routes.adminOverview);
    error.value = null;
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    loading.value = false;
  }
}

/* --------------------------------------------------------------- 实时 */

let client: RealtimeClient | null = null;
let lastRefresh = 0;

function scheduleRefresh(): void {
  const now = Date.now();
  if (now - lastRefresh < 6000) return;
  lastRefresh = now;
  void load();
}

onMounted(() => {
  void load();
  client = new RealtimeClient({
    topics: [Topics.platform, Topics.nodes],
    onEvent: (event: ServerEvent) => {
      if (event.type === 'traffic.tick' || event.type === 'node.update' || event.type === 'room.update') {
        scheduleRefresh();
      }
    },
  });
  client.connect();
});

onUnmounted(() => {
  client?.close();
  client = null;
});

/* --------------------------------------------------------------- 派生 */

/* 字段缺失时的兜底值：宁可显示 0 也不要让渲染中断 */
const EMPTY_NODE_COUNTS: NodeCounts = { total: 0, online: 0, degraded: 0, offline: 0, pending: 0 };
const EMPTY_ROOM_COUNTS: RoomCounts = { open: 0, total: 0, onlinePlayers: 0 };
const EMPTY_TRAFFIC = { rxBps: 0, txBps: 0, rxBytesToday: 0, txBytesToday: 0 };

const cards = computed(() => {
  const ov = overview.value;
  if (!ov) return [];
  // 旧版/异常响应可能缺块，逐块兜底而不是让它把整页带走
  const n = ov.nodes ?? EMPTY_NODE_COUNTS;
  const r = ov.rooms ?? EMPTY_ROOM_COUNTS;
  const traffic = ov.traffic ?? EMPTY_TRAFFIC;
  return [
    { label: '在线节点', value: n.online, hint: `共 ${n.total} 个`, accent: 'ok' as const },
    { label: '降级节点', value: n.degraded, hint: '接近容量上限', accent: 'warn' as const },
    { label: '离线节点', value: n.offline, hint: '心跳超时', accent: 'danger' as const },
    { label: '待上线节点', value: n.pending, hint: '已注册，等第一次心跳', accent: 'accent' as const },
    { label: '开放房间', value: r.open, hint: `累计 ${r.total} 个`, accent: 'brand' as const },
    { label: '在线玩家', value: r.onlinePlayers, hint: '90 秒内有心跳', accent: 'brand' as const },
    {
      label: '注册用户',
      value: ov.users?.total ?? 0,
      hint: `WebSocket 在线 ${ov.users?.online ?? 0}`,
      accent: 'accent' as const,
    },
    {
      // 全网口径：所有在线子节点之和（转发全部由子节点承担，主控不再自带中继）
      label: '全网接收',
      value: formatBitrate(traffic.rxBps),
      hint: `${traffic.onlineRelayNodes} 个在线子节点 ${formatBitrate(traffic.nodesRxBps)}`,
      accent: 'violet' as const,
    },
    {
      label: '全网发送',
      value: formatBitrate(traffic.txBps),
      hint: `${traffic.onlineRelayNodes} 个在线子节点 ${formatBitrate(traffic.nodesTxBps)}`,
      accent: 'violet' as const,
    },
  ];
});

const nodeRows = computed(() => asArray(overview.value?.recentNodes));
const roomRows = computed(() => asArray(overview.value?.recentRooms));
const auditRows = computed(() => asArray(overview.value?.recentAudit));
const warnings = computed(() => asStringList(overview.value?.warnings));
</script>

<template>
  <div class="console-page">
    <header class="console-head">
      <div class="console-head-text">
        <h1 class="console-head-title">仪表盘</h1>
        <p class="console-head-sub">
          <template v-if="overview">
            服务端时间 {{ formatDateTime(overview.serverTime) }} · 主控已运行 {{ formatDuration(overview.uptimeSeconds) }} ·
            实时事件会自动刷新本页
          </template>
          <template v-else>平台概览、节点与房间速览、最近操作。</template>
        </p>
      </div>
      <div class="console-head-actions">
        <button class="btn" type="button" :disabled="loading" @click="load">
          <span v-if="loading" class="spinner" />
          刷新
        </button>
      </div>
    </header>

    <!-- 加载中 -->
    <div v-if="loading && !overview" class="stat-grid">
      <div v-for="i in 6" :key="i" class="stat-skeleton">
        <div class="skeleton" style="height: 11px; width: 44%" />
        <div class="skeleton" style="height: 24px; width: 60%; margin-top: 9px" />
      </div>
    </div>

    <!-- 失败 -->
    <section v-else-if="error && !overview" class="console-section">
      <div class="console-section-head">
        <div class="console-section-text">
          <div class="console-sub-title">概览加载失败</div>
          <p class="console-section-note">{{ error }}</p>
        </div>
        <button class="btn" type="button" @click="load">重试</button>
      </div>
    </section>

    <template v-else>
      <!-- 告警条：配置层面有问题时最需要被看到 -->
      <div v-if="warnings.length > 0" class="notice notice-warn warn-block">
        <div class="warn-block-head">
          <Badge tone="warn">配置告警 {{ warnings.length }} 条</Badge>
          <span class="cell-sub">来自主控启动时的环境校验，可能需要人工处理</span>
        </div>
        <ul class="warn-list">
          <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
        </ul>
      </div>

      <div v-if="error" class="notice notice-danger">
        <Badge tone="danger">刷新失败</Badge>
        <span class="notice-body">{{ error }}</span>
        <button class="btn btn-sm" type="button" @click="load">重试</button>
      </div>

      <!-- StatCard 组 -->
      <div class="stat-grid">
        <StatCard
          v-for="c in cards"
          :key="c.label"
          :label="c.label"
          :value="c.value"
          :hint="c.hint"
          :accent="c.accent"
        />
      </div>

      <!-- system 信息块 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">系统信息</h2>
            <p class="console-section-note">主控进程自身的运行时读数（转发全在子节点上，主控只跑控制面）。</p>
          </div>
        </div>
        <div v-if="overview" class="kv">
          <span class="kv-k">平台版本</span><span class="kv-v mono">{{ overview.version }}</span>
          <span class="kv-k">EasyTier 核心</span>
          <span class="kv-v mono">{{ overview.easytierVersion ?? '未探测' }}</span>
          <span class="kv-k">Node 版本</span><span class="kv-v mono">{{ overview.system?.nodeVersion ?? '未知' }}</span>
          <span class="kv-k">运行平台</span><span class="kv-v mono">{{ overview.system?.platform ?? '未知' }}</span>
          <span class="kv-k">Schema 版本</span><span class="kv-v mono">{{ overview.system?.schemaVersion ?? '未知' }}</span>
          <span class="kv-k">数据库</span>
          <span class="kv-v mono wrap-anywhere">{{ overview.system?.dbFile ?? '未记录' }}</span>
          <span class="kv-k">进程 PID</span><span class="kv-v mono">{{ overview.system?.pid ?? '未知' }}</span>
          <span class="kv-k">内存占用</span><span class="kv-v mono">{{ overview.system?.memoryMb ?? '未知' }} MB</span>
          <span class="kv-k">服务端时间</span><span class="kv-v mono">{{ formatDateTime(overview.serverTime) }}</span>
          <span class="kv-k">已运行</span><span class="kv-v">{{ formatDuration(overview.uptimeSeconds) }}</span>
        </div>
      </section>

      <!-- 节点表 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">中继节点</h2>
            <p class="console-section-note">最多显示前 12 个，完整列表与操作在中继节点页</p>
          </div>
          <RouterLink class="btn btn-sm" to="/console/nodes">全部节点</RouterLink>
        </div>

        <div v-if="nodeRows.length === 0" class="empty">还没有注册任何子节点，此时建房会直接失败（主控自身不再作兜底中继）。</div>
        <div v-else class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>节点</th>
                <th>区域</th>
                <th>状态</th>
                <th class="table-num">peer</th>
                <th class="table-num">房间</th>
                <th class="table-num">实时速率</th>
                <th class="table-num">权重</th>
                <th>最近心跳</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="n in nodeRows" :key="n.id">
                <td>
                  <div class="wrap-anywhere">{{ n.name }}</div>
                  <div class="cell-sub">{{ n.endpoint }}</div>
                </td>
                <td>{{ regionLabel(n.region) }}</td>
                <td><Badge :tone="nodeTone(n.status)" dot>{{ nodeLabel(n.status) }}</Badge></td>
                <td class="table-num">{{ n.peers }} / {{ n.capacityPeers }}</td>
                <td class="table-num">{{ n.rooms }}</td>
                <td class="table-num">{{ formatBitrate(n.rxBps) }} / {{ formatBitrate(n.txBps) }}</td>
                <td class="table-num">{{ n.weight }}</td>
                <td class="cell-sub">{{ formatRelativeTime(n.lastSeenAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 房间表 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">开放中的房间</h2>
            <p class="console-section-note">最多显示前 12 个，详情与强制关闭在房间管理页</p>
          </div>
          <RouterLink class="btn btn-sm" to="/console/rooms">房间管理</RouterLink>
        </div>

        <div v-if="roomRows.length === 0" class="empty">当前没有开放中的房间。</div>
        <div v-else class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>房间</th>
                <th>加入码</th>
                <th>房主</th>
                <th>区域</th>
                <th>状态</th>
                <th class="table-num">在线</th>
                <th>虚拟网段</th>
                <th>创建时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in roomRows" :key="r.id">
                <td class="wrap-anywhere">{{ r.name }}</td>
                <td class="mono">{{ r.code }}</td>
                <td class="wrap-anywhere">{{ r.hostDisplayName }}</td>
                <td>{{ regionLabel(r.zone) }}</td>
                <td><Badge :tone="roomTone(r.status)" dot>{{ roomLabel(r.status) }}</Badge></td>
                <td class="table-num">{{ r.onlineMembers }} / {{ r.policy.maxPlayers }}</td>
                <td class="mono">{{ r.subnet }}</td>
                <td class="cell-sub">{{ formatRelativeTime(r.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 审计时间线 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">最近操作</h2>
            <p class="console-section-note">最近 15 条审计记录</p>
          </div>
          <RouterLink class="btn btn-sm" to="/console/audit">全部日志</RouterLink>
        </div>

        <div v-if="auditRows.length === 0" class="empty">暂无审计记录。</div>
        <ol v-else class="timeline">
          <li v-for="a in auditRows" :key="a.id">
            <span class="led led-signal tl-led" />
            <div class="timeline-body">
              <div class="tl-head">
                <span class="timeline-action">{{ a.action }}</span>
                <Badge tone="neutral">{{ a.actorType }}</Badge>
                <span class="cell-sub">{{ a.actorName ?? a.actorId ?? '系统' }}</span>
                <span class="tl-time cell-sub">{{ formatRelativeTime(a.ts) }}</span>
              </div>
              <div v-if="a.targetType" class="cell-sub">
                目标：{{ a.targetType }}{{ a.targetId ? ` · ${a.targetId}` : '' }}
                <template v-if="a.ip"> · 来源 {{ a.ip }}</template>
              </div>
            </div>
          </li>
        </ol>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* 读数格子：与 StatCard 自带的上下留白配合，用发丝线分格而不是卡片 */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(178px, 1fr));
  border-top: 1px solid var(--rule);
}
.stat-grid :deep(.stat) {
  padding-right: var(--s-4);
  border-bottom: 1px solid var(--rule);
}
.stat-skeleton {
  padding: var(--s-4) var(--s-4) var(--s-4) 0;
  border-bottom: 1px solid var(--rule);
}
.warn-block {
  flex-direction: column;
  align-items: stretch;
  gap: var(--s-3);
}
.warn-block-head {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex-wrap: wrap;
}
.warn-list {
  margin: 0;
  padding-left: 1.15em;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: var(--fs-sm);
  overflow-wrap: anywhere;
}
.notice-body {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.tl-led {
  margin-top: 7px;
}
.tl-head {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}
.tl-time {
  margin-left: auto;
}
</style>
