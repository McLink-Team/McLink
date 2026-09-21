<script setup lang="ts">
/**
 * 流量监控：平台总量趋势 + 按房间/按节点归因。
 *
 * `/admin/traffic` 返回的 `foreignNetworks` 里 `roomId` 恒为 null（主控采样时还没做映射，
 * 映射只发生在 WebSocket 推送的那份副本上），所以这里额外取一次房间列表，
 * 用 `networkName → 房间` 建立映射，才能把「外来网络」标到具体房间上。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  Routes,
  Topics,
  formatBitrate,
  formatBytes,
  formatRelativeTime,
  regionLabel,
  type ForeignNetworkInfo,
  type Room,
  type ServerEvent,
  type TrafficPoint,
} from '@mclink/shared';
import { api, friendlyError } from '../../lib/api.ts';
import { RealtimeClient } from '../../lib/realtime.ts';
import { formatDateTime } from '../../lib/ui.ts';
import Badge from '../../components/Badge.vue';
import Sparkline from '../../components/Sparkline.vue';
import StatCard from '../../components/StatCard.vue';

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
  platform: { points: TrafficPoint[]; rxBps: number; txBps: number; rxBytes: number; txBytes: number };
  foreignNetworks: ForeignNetworkInfo[];
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
const roomById = ref<Map<string, Room>>(new Map());
const roomByNetwork = ref<Map<string, Room>>(new Map());
const loading = ref(true);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [traffic, roomsResult] = await Promise.all([
      api.get<TrafficResponse>(Routes.adminTraffic, { query: { minutes: minutes.value } }),
      api.get<{ rooms: Room[]; total: number }>(Routes.adminRooms, { query: { limit: 200 } }),
    ]);
    data.value = traffic;
    const byId = new Map<string, Room>();
    const byNetwork = new Map<string, Room>();
    for (const room of roomsResult.rooms) {
      byId.set(room.id, room);
      byNetwork.set(room.networkName, room);
    }
    roomById.value = byId;
    roomByNetwork.value = byNetwork;
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

const platform = computed(() => data.value?.platform.points ?? []);
const totals = computed(() => data.value?.totals ?? { rxBytes: 0, txBytes: 0 });
const foreignNetworks = computed(() => data.value?.foreignNetworks ?? []);
const roomSeries = computed(() => data.value?.rooms ?? []);
const nodeSeries = computed(() => data.value?.nodes ?? []);

function resolveRoom(networkName: string, roomId: string | null): Room | null {
  if (roomId) {
    const direct = roomById.value.get(roomId);
    if (direct) return direct;
  }
  return roomByNetwork.value.get(networkName) ?? null;
}

const cards = computed(() => {
  const p = data.value?.platform;
  return [
    { label: '实时接收', value: p ? formatBitrate(p.rxBps) : '—', hint: `区间累计 ${formatBytes(p?.rxBytes ?? 0)}`, accent: 'brand' as const },
    { label: '实时发送', value: p ? formatBitrate(p.txBps) : '—', hint: `区间累计 ${formatBytes(p?.txBytes ?? 0)}`, accent: 'violet' as const },
    { label: '今日累计接收', value: formatBytes(totals.value.rxBytes), hint: '自然日 00:00 起', accent: 'accent' as const },
    { label: '今日累计发送', value: formatBytes(totals.value.txBytes), hint: '自然日 00:00 起', accent: 'accent' as const },
    { label: '外来网络', value: foreignNetworks.value.length, hint: '正在经由主控中继的房间网络', accent: 'ok' as const },
    { label: '开放房间', value: roomSeries.value.length, hint: '按房间归因的流量序列', accent: 'warn' as const },
  ];
});
</script>

<template>
  <div class="stack" style="gap: var(--s-5)">
    <div class="row-between wrap">
      <div>
        <div class="panel-title">流量监控</div>
        <p class="panel-sub">
          <template v-if="data">统计起点 {{ formatDateTime(data.since) }} · </template>
          采样间隔约 5 秒；中继出口限速按 kbps 配置，界面统一换算为 bit/s 展示。
        </p>
      </div>
      <div class="row">
        <div class="range-group">
          <button
            v-for="r in RANGES"
            :key="r.minutes"
            class="range-btn"
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
    </div>

    <div v-if="loading && !data" class="grid cards">
      <div v-for="i in 6" :key="i" class="card">
        <div class="skeleton" style="height: 12px; width: 40%" />
        <div class="skeleton" style="height: 26px; width: 60%; margin-top: 10px" />
      </div>
    </div>

    <div v-else-if="error && !data" class="card">
      <div class="row-between">
        <div>
          <div class="panel-title" style="font-size: var(--fs-base)">流量数据加载失败</div>
          <p class="panel-sub">{{ error }}</p>
        </div>
        <button class="btn" type="button" @click="load">重试</button>
      </div>
    </div>

    <template v-else>
      <div v-if="error" class="warn-bar">
        <div class="row wrap" style="gap: var(--s-3)">
          <Badge tone="danger">刷新失败</Badge>
          <span class="grow">{{ error }}</span>
          <button class="btn btn-sm" type="button" @click="load">重试</button>
        </div>
      </div>

      <div class="grid cards">
        <StatCard v-for="c in cards" :key="c.label" :label="c.label" :value="c.value" :hint="c.hint" :accent="c.accent" />
      </div>

      <!-- 平台总趋势 -->
      <section class="card stack">
        <div class="row-between">
          <div>
            <div class="panel-title" style="font-size: var(--fs-base)">平台总收发趋势</div>
            <p class="panel-sub">实线为接收，虚线为发送；纵轴按区间峰值自适应。</p>
          </div>
          <div class="row" style="gap: var(--s-3); font-size: var(--fs-xs)">
            <span class="row" style="gap: 6px"><span class="legend-line brand" /> 接收</span>
            <span class="row" style="gap: 6px"><span class="legend-line accent dashed" /> 发送</span>
          </div>
        </div>
        <Sparkline :points="platform" compare :height="110" />
      </section>

      <!-- 外来网络归因 -->
      <section class="card stack">
        <div>
          <div class="panel-title" style="font-size: var(--fs-base)">外来网络 → 房间归因</div>
          <p class="panel-sub">
            主控中继正在为其转发的外来网络。这是判断「哪个房间在吃带宽」最直接的视图；
            「未映射」表示该网络的房间已关闭或尚未登记。
          </p>
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
                <td class="mono truncate" style="font-size: var(--fs-xs); max-width: 240px" :title="f.networkName">
                  {{ f.networkName }}
                </td>
                <td>
                  <template v-if="resolveRoom(f.networkName, f.roomId)">
                    <div>{{ resolveRoom(f.networkName, f.roomId)?.name }}</div>
                    <div class="faint" style="font-size: var(--fs-xs)">
                      <span class="mono">{{ resolveRoom(f.networkName, f.roomId)?.code }}</span>
                      · {{ regionLabel(resolveRoom(f.networkName, f.roomId)?.zone ?? '') }}
                    </div>
                  </template>
                  <Badge v-else tone="warn">未映射</Badge>
                </td>
                <td class="table-num">{{ f.peerCount }}</td>
                <td class="table-num">{{ formatBitrate(f.rxBps) }}</td>
                <td class="table-num">{{ formatBitrate(f.txBps) }}</td>
                <td class="table-num">{{ formatBytes(f.rxBytes) }}</td>
                <td class="table-num">{{ formatBytes(f.txBytes) }}</td>
                <td class="muted" style="font-size: var(--fs-xs)">{{ formatRelativeTime(f.lastSeenAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 房间流量 -->
      <section class="card stack">
        <div class="panel-title" style="font-size: var(--fs-base)">房间流量（最近 {{ roomSeries.length }} 个开放房间）</div>
        <div v-if="roomSeries.length === 0" class="empty">当前没有开放房间的流量样本。</div>
        <div v-else class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>房间</th>
                <th class="table-num">peer</th>
                <th class="table-num">累计接收</th>
                <th class="table-num">累计发送</th>
                <th style="width: 200px">趋势</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in roomSeries" :key="r.id">
                <td class="truncate" style="max-width: 260px">{{ r.label }}</td>
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
      <section class="card stack">
        <div class="panel-title" style="font-size: var(--fs-base)">节点流量</div>
        <div v-if="nodeSeries.length === 0" class="empty">还没有注册任何子节点。</div>
        <div v-else class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>节点</th>
                <th class="table-num">peer</th>
                <th class="table-num">实时接收</th>
                <th class="table-num">实时发送</th>
                <th style="width: 200px">趋势</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="n in nodeSeries" :key="n.id">
                <td class="truncate" style="max-width: 260px">{{ n.label }}</td>
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
.cards {
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
}
.table-wrap {
  overflow-x: auto;
}
.range-group {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  border-radius: var(--r-sm);
  background: var(--surface);
  border: 1px solid var(--border);
}
.range-btn {
  height: 30px;
  padding: 0 var(--s-3);
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--text-dim);
  font-size: var(--fs-xs);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.range-btn:hover {
  color: var(--text);
}
.range-btn.active {
  background: var(--surface-strong);
  color: var(--text);
}
.legend-line {
  display: inline-block;
  width: 16px;
  height: 0;
  border-top-width: 2px;
  border-top-style: solid;
}
.legend-line.brand {
  border-color: var(--brand);
}
.legend-line.accent {
  border-color: var(--accent);
}
.legend-line.dashed {
  border-top-style: dashed;
}
.warn-bar {
  padding: var(--s-3) var(--s-4);
  border-radius: var(--r-md);
  background: var(--warn-bg);
  border: 1px solid rgba(255, 200, 74, 0.28);
  font-size: var(--fs-sm);
}
</style>
