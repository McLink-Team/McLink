<script setup lang="ts">
/**
 * 流量监控：平台总量趋势 + 按房间/按节点归因。
 *
 * `foreignNetworks[]` 现在由服务端完成 `networkName → 房间` 映射，
 * 直接带 `roomId` / `roomName` / `roomCode`（取不到时为 null），因此不再需要额外拉房间列表。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  Routes,
  Topics,
  formatBitrate,
  formatBytes,
  formatRelativeTime,
  type ForeignNetworkInfo,
  type ServerEvent,
  type TrafficPoint,
} from '@mclink/shared';
import { api, friendlyError } from '../../lib/api.ts';
import { RealtimeClient } from '../../lib/realtime.ts';
import { asArray, formatDateTime } from '../../lib/ui.ts';
import Badge from '../../components/Badge.vue';
import Sparkline from '../../components/Sparkline.vue';
import StatCard from '../../components/StatCard.vue';

/** 服务端在采样结果上补了房间归因字段 */
interface ForeignNetworkMapped extends ForeignNetworkInfo {
  roomName: string | null;
  roomCode: string | null;
}

interface RoomSeries {
  id: string;
  label: string;
  points: TrafficPoint[];
  rxBytes?: number;
  txBytes?: number;
  peers?: number;
}

interface NodeSeries {
  id: string;
  label: string;
  points: TrafficPoint[];
  rxBps: number;
  txBps: number;
  peers: number;
}

interface TrafficResponse {
  since: string;
  /** rxBps/txBps 为全网聚合；masterRxBps 是主控那一台，nodesRxBps 是子节点之和 */
  platform: {
    points: TrafficPoint[];
    rxBps: number;
    txBps: number;
    rxBytes: number;
    txBytes: number;
    masterRxBps: number;
    masterTxBps: number;
    nodesRxBps: number;
    nodesTxBps: number;
    onlineRelayNodes: number;
  };
  foreignNetworks: ForeignNetworkMapped[];
  rooms: RoomSeries[];
  nodes: NodeSeries[];
  totals: { rxBytes: number; txBytes: number };
}

const RANGES = [
  { minutes: 15, label: '15 分钟' },
  { minutes: 60, label: '1 小时' },
  { minutes: 360, label: '6 小时' },
  { minutes: 1440, label: '24 小时' },
];

const minutes = ref(60);
const data = ref<TrafficResponse | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await api.get<TrafficResponse>(Routes.adminTraffic, { query: { minutes: minutes.value } });
    error.value = null;
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    loading.value = false;
  }
}

function setRange(value: number): void {
  if (minutes.value === value) return;
  minutes.value = value;
  void load();
}

/* --------------------------------------------------------------- 实时 */

let client: RealtimeClient | null = null;
let lastRefresh = 0;

onMounted(() => {
  void load();
  client = new RealtimeClient({
    topics: [Topics.traffic, Topics.platform],
    onEvent: (event: ServerEvent) => {
      if (event.type !== 'relay.update' && event.type !== 'traffic.tick') return;
      const now = Date.now();
      if (now - lastRefresh < 10_000) return;
      lastRefresh = now;
      void load();
    },
  });
  client.connect();
});

onUnmounted(() => {
  client?.close();
  client = null;
});

/* --------------------------------------------------------------- 派生 */

const platform = computed(() => asArray(data.value?.platform?.points));
const totals = computed(() => data.value?.totals ?? { rxBytes: 0, txBytes: 0 });
const foreignNetworks = computed(() => asArray(data.value?.foreignNetworks));
const roomSeries = computed(() => asArray(data.value?.rooms));
const nodeSeries = computed(() => asArray(data.value?.nodes));

const cards = computed(() => {
  const p = data.value?.platform;
  // 读数用纸白（数据本身不是状态）；只有"外来网络"是值得被注意的信号，用告警色。
  return [
    {
      // 全网口径：主控中继 + 所有在线子节点（只算主控会长期是 0）
      label: '全网实时接收',
      value: p ? formatBitrate(p.rxBps) : '未采样',
      hint: p ? `主控 ${formatBitrate(p.masterRxBps)} + ${p.onlineRelayNodes} 节点 ${formatBitrate(p.nodesRxBps)}` : '未采样',
      accent: 'accent' as const,
    },
    {
      label: '全网实时发送',
      value: p ? formatBitrate(p.txBps) : '未采样',
      hint: p ? `主控 ${formatBitrate(p.masterTxBps)} + ${p.onlineRelayNodes} 节点 ${formatBitrate(p.nodesTxBps)}` : '未采样',
      accent: 'accent' as const,
    },
    { label: '今日累计接收', value: formatBytes(totals.value.rxBytes), hint: '自然日 00:00 起', accent: 'accent' as const },
    { label: '今日累计发送', value: formatBytes(totals.value.txBytes), hint: '自然日 00:00 起', accent: 'accent' as const },
    { label: '外来网络', value: foreignNetworks.value.length, hint: '正在经由主控中继的房间网络', accent: 'warn' as const },
    { label: '开放房间', value: roomSeries.value.length, hint: '按房间归因的流量序列', accent: 'accent' as const },
  ];
});
</script>

<template>
  <div class="console-page">
    <header class="console-head">
      <div class="console-head-text">
        <h1 class="console-head-title">流量监控</h1>
        <p class="console-head-sub">
          <template v-if="data">统计起点 {{ formatDateTime(data.since) }} · </template>
          采样间隔约 5 秒；中继出口限速按 kbps 配置，界面统一换算为 bit/s 展示。
        </p>
      </div>
      <div class="console-head-actions">
        <div class="seg">
          <button
            v-for="r in RANGES"
            :key="r.minutes"
            class="seg-item"
            :class="{ active: minutes === r.minutes }"
            type="button"
            @click="setRange(r.minutes)"
          >
            {{ r.label }}
          </button>
        </div>
        <button class="btn" type="button" :disabled="loading" @click="load">
          <span v-if="loading" class="spinner" />
          刷新
        </button>
      </div>
    </header>

    <div v-if="loading && !data" class="stat-grid">
      <div v-for="i in 6" :key="i" class="stat-skeleton">
        <div class="skeleton" style="height: 11px; width: 42%" />
        <div class="skeleton" style="height: 24px; width: 62%; margin-top: 9px" />
      </div>
    </div>

    <section v-else-if="error && !data" class="console-section">
      <div class="console-section-head">
        <div class="console-section-text">
          <div class="console-sub-title">流量数据加载失败</div>
          <p class="console-section-note">{{ error }}</p>
        </div>
        <button class="btn" type="button" @click="load">重试</button>
      </div>
    </section>

    <template v-else>
      <div v-if="error" class="notice notice-warn">
        <Badge tone="danger">刷新失败</Badge>
        <span class="notice-body">{{ error }}</span>
        <button class="btn btn-sm" type="button" @click="load">重试</button>
      </div>

      <div class="stat-grid">
        <StatCard v-for="c in cards" :key="c.label" :label="c.label" :value="c.value" :hint="c.hint" :accent="c.accent" />
      </div>

      <!-- 平台总趋势 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">平台总收发趋势</h2>
            <p class="console-section-note">实线为接收，虚线为发送；纵轴按区间峰值自适应。</p>
          </div>
          <div class="legend">
            <span class="legend-item"><span class="legend-line legend-rx" /> 接收</span>
            <span class="legend-item"><span class="legend-line legend-tx" /> 发送</span>
          </div>
        </div>
        <Sparkline :points="platform" compare :height="110" />
      </section>

      <!-- 外来网络归因 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">外来网络 → 房间归因</h2>
            <p class="console-section-note">
              主控中继正在为其转发的外来网络。这是判断「哪个房间在吃带宽」最直接的视图；
              「未映射」表示该网络的房间已关闭或尚未登记。
            </p>
          </div>
        </div>

        <div v-if="foreignNetworks.length === 0" class="empty">
          当前没有外来网络经由主控中继，或 easytier-cli 不可用导致无法采样。
        </div>
        <div v-else class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>网络名</th>
                <th>映射房间</th>
                <th class="table-num">peer</th>
                <th class="table-num">接收速率</th>
                <th class="table-num">发送速率</th>
                <th class="table-num">累计接收</th>
                <th class="table-num">累计发送</th>
                <th>最近采样</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in foreignNetworks" :key="f.networkName">
                <td class="mono cell-sub">{{ f.networkName }}</td>
                <td>
                  <template v-if="f.roomName || f.roomCode">
                    <div>{{ f.roomName ?? '未命名房间' }}</div>
                    <div class="cell-sub">
                      <span v-if="f.roomCode">{{ f.roomCode }}</span>
                      <span v-if="f.roomId"> · {{ f.roomId }}</span>
                    </div>
                  </template>
                  <Badge v-else tone="warn">未映射</Badge>
                </td>
                <td class="table-num">{{ f.peerCount }}</td>
                <td class="table-num">{{ formatBitrate(f.rxBps) }}</td>
                <td class="table-num">{{ formatBitrate(f.txBps) }}</td>
                <td class="table-num">{{ formatBytes(f.rxBytes) }}</td>
                <td class="table-num">{{ formatBytes(f.txBytes) }}</td>
                <td class="cell-sub">{{ formatRelativeTime(f.lastSeenAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 房间流量 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">房间流量</h2>
            <p class="console-section-note">最近 {{ roomSeries.length }} 个开放房间的收发序列。</p>
          </div>
        </div>
        <div v-if="roomSeries.length === 0" class="empty">当前没有开放房间的流量样本。</div>
        <div v-else class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>房间</th>
                <th class="table-num">peer</th>
                <th class="table-num">累计接收</th>
                <th class="table-num">累计发送</th>
                <th class="col-spark">趋势</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in roomSeries" :key="r.id">
                <td class="wrap-anywhere">{{ r.label }}</td>
                <td class="table-num">{{ r.peers ?? 0 }}</td>
                <td class="table-num">{{ formatBytes(r.rxBytes ?? 0) }}</td>
                <td class="table-num">{{ formatBytes(r.txBytes ?? 0) }}</td>
                <td>
                  <Sparkline :points="r.points" compare :height="34" :area="false" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 节点流量 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">节点流量</h2>
            <p class="console-section-note">按子节点归因的实时速率与累计值。</p>
          </div>
        </div>
        <div v-if="nodeSeries.length === 0" class="empty">还没有注册任何子节点。</div>
        <div v-else class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>节点</th>
                <th class="table-num">peer</th>
                <th class="table-num">实时接收</th>
                <th class="table-num">实时发送</th>
                <th class="col-spark">趋势</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="n in nodeSeries" :key="n.id">
                <td class="wrap-anywhere">{{ n.label }}</td>
                <td class="table-num">{{ n.peers }}</td>
                <td class="table-num">{{ formatBitrate(n.rxBps) }}</td>
                <td class="table-num">{{ formatBitrate(n.txBps) }}</td>
                <td>
                  <Sparkline :points="n.points" compare :height="34" :area="false" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
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
.legend {
  display: flex;
  align-items: center;
  gap: var(--s-4);
  font-size: var(--fs-xs);
  color: var(--paper-dim);
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.legend-line {
  display: inline-block;
  width: 16px;
  height: 0;
  border-top-width: 2px;
  border-top-style: solid;
}
.legend-rx {
  border-color: var(--signal);
}
.legend-tx {
  border-color: var(--sky);
  border-top-style: dashed;
}
.col-spark {
  width: 200px;
}
.notice-body {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
