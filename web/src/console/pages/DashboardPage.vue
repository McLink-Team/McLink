<script setup lang="ts">
/**
 * 仪表盘：平台概览 + 中继运行状态 + 节点/房间速览 + 审计时间线。
 *
 * 注意一个接口细节：`/admin/overview` 里的 `nodes` 与 `rooms` 被服务端**覆盖成了数组**
 * （原本是状态计数对象），所以节点状态分布与房间数改用公开的 `/stats` 补齐，
 * 这样 StatCard 的数字才是全量精确值而不是「前 12 条」的统计。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  Routes,
  Topics,
  formatBitrate,
  formatBytes,
  formatDuration,
  formatRelativeTime,
  regionLabel,
  type AuditEntry,
  type RelayNode,
  type RelayRuntime,
  type Room,
  type ServerEvent,
} from '@mclink/shared';
import { api, friendlyError } from '../../lib/api.ts';
import { RealtimeClient } from '../../lib/realtime.ts';
import { formatDateTime, nodeLabel, nodeTone, roomLabel, roomTone } from '../../lib/ui.ts';
import StatCard from '../../components/StatCard.vue';
import Badge from '../../components/Badge.vue';

interface AdminRelayRuntime extends RelayRuntime {
  version: string | null;
  cliAvailable: boolean;
  whitelist: string[];
  port: number;
  rpcPortal: string;
  binary: string;
  logFile: string;
  configFile: string;
}

interface AdminOverview {
  serverTime: string;
  version: string;
  easytierVersion: string | null;
  uptimeSeconds: number;
  nodes: RelayNode[];
  rooms: Room[];
  users: { total: number; online: number };
  traffic: { rxBps: number; txBps: number; rxBytesToday: number; txBytesToday: number };
  relay: AdminRelayRuntime | null;
  system: {
    nodeVersion: string;
    platform: string;
    schemaVersion: number | string;
    dbFile: string;
    pid: number;
    memoryMb: number;
  };
  recentAudit: AuditEntry[];
  warnings: string[];
}

interface PlatformStats {
  serverTime: string;
  nodes: { total: number; online: number; degraded: number; offline: number; pending: number };
  rooms: { open: number; total: number; onlinePlayers: number };
  users: { total: number; online: number };
  traffic: { rxBps: number; txBps: number; rxBytesToday: number; txBytesToday: number };
}

const overview = ref<AdminOverview | null>(null);
const stats = ref<PlatformStats | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  try {
    const [ov, st] = await Promise.all([
      api.get<AdminOverview>(Routes.adminOverview),
      api.get<PlatformStats>(Routes.stats),
    ]);
    overview.value = ov;
    stats.value = st;
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

const relay = computed(() => overview.value?.relay ?? null);

const cards = computed(() => {
  const s = stats.value;
  const ov = overview.value;
  return [
    { label: '在线节点', value: s ? s.nodes.online : '—', hint: s ? `共 ${s.nodes.total} 个` : '', accent: 'ok' as const },
    { label: '降级节点', value: s ? s.nodes.degraded : '—', hint: '接近容量上限', accent: 'warn' as const },
    { label: '离线节点', value: s ? s.nodes.offline : '—', hint: '心跳超时', accent: 'danger' as const },
    { label: '待审核节点', value: s ? s.nodes.pending : '—', hint: '等待首次心跳', accent: 'accent' as const },
    { label: '开放房间', value: s ? s.rooms.open : '—', hint: s ? `累计 ${s.rooms.total} 个` : '', accent: 'brand' as const },
    { label: '在线玩家', value: s ? s.rooms.onlinePlayers : '—', hint: '90 秒内有心跳', accent: 'brand' as const },
    { label: '注册用户', value: s ? s.users.total : '—', hint: '含管理员', accent: 'accent' as const },
    {
      label: '实时接收',
      value: ov ? formatBitrate(ov.traffic.rxBps) : '—',
      hint: ov ? `今日 ${formatBytes(ov.traffic.rxBytesToday)}` : '',
      accent: 'violet' as const,
    },
    {
      label: '实时发送',
      value: ov ? formatBitrate(ov.traffic.txBps) : '—',
      hint: ov ? `今日 ${formatBytes(ov.traffic.txBytesToday)}` : '',
      accent: 'violet' as const,
    },
  ];
});

const nodeRows = computed(() => overview.value?.nodes ?? []);
const roomRows = computed(() => overview.value?.rooms ?? []);
const auditRows = computed(() => overview.value?.recentAudit ?? []);
const warnings = computed(() => overview.value?.warnings ?? []);
</script>

<template>
  <div class="stack" style="gap: var(--s-5)">
    <!-- 加载中 -->
    <div v-if="loading && !overview" class="grid cards">
      <div v-for="i in 6" :key="i" class="card">
        <div class="skeleton" style="height: 12px; width: 40%" />
        <div class="skeleton" style="height: 26px; width: 60%; margin-top: 10px" />
      </div>
    </div>

    <!-- 失败 -->
    <div v-else-if="error && !overview" class="card stack">
      <div class="row-between">
        <div>
          <div class="panel-title">概览加载失败</div>
          <p class="panel-sub">{{ error }}</p>
        </div>
        <button class="btn" type="button" @click="load">重试</button>
      </div>
    </div>

    <template v-else>
      <!-- 告警条：配置层面有问题时最需要被看到 -->
      <div v-if="warnings.length > 0" class="warn-bar stack" style="gap: var(--s-2)">
        <div class="row" style="gap: var(--s-2)">
          <Badge tone="warn">配置告警 {{ warnings.length }} 条</Badge>
          <span class="faint" style="font-size: var(--fs-xs)">来自主控启动时的环境校验，可能需要人工处理</span>
        </div>
        <ul class="warn-list">
          <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
        </ul>
      </div>

      <div v-if="error" class="warn-bar">
        <div class="row wrap" style="gap: var(--s-3)">
          <Badge tone="danger">刷新失败</Badge>
          <span class="grow">{{ error }}</span>
          <button class="btn btn-sm" type="button" @click="load">重试</button>
        </div>
      </div>

      <!-- StatCard 组 -->
      <div class="grid cards">
        <StatCard
          v-for="c in cards"
          :key="c.label"
          :label="c.label"
          :value="c.value"
          :hint="c.hint"
          :accent="c.accent"
        />
      </div>

      <div class="grid two">
        <!-- 中继运行状态 -->
        <section class="card stack">
          <div class="row-between">
            <div>
              <div class="panel-title">主控中继</div>
              <p class="panel-sub">单端口共享中继，为所有房间转发（EasyTier network whitelist 通配）</p>
            </div>
            <Badge :tone="relay?.running ? 'ok' : 'danger'" dot :pulse="Boolean(relay?.running)">
              {{ relay?.running ? '运行中' : '未运行' }}
            </Badge>
          </div>

          <template v-if="relay">
            <div class="kv">
              <span class="kv-k">监听地址</span><span class="kv-v mono">{{ relay.listen }}</span>
              <span class="kv-k">网络名</span><span class="kv-v mono">{{ relay.networkName }}</span>
              <span class="kv-k">白名单</span>
              <span class="kv-v mono truncate" :title="relay.whitelist.join(', ')">
                {{ relay.whitelist.length > 0 ? relay.whitelist.join(', ') : '（未配置）' }}
              </span>
              <span class="kv-k">CLI 版本</span>
              <span class="kv-v mono">
                {{ relay.version ?? '未探测到 easytier-cli' }}
                <Badge v-if="!relay.cliAvailable" tone="warn">流量统计不可用</Badge>
              </span>
              <span class="kv-k">RPC Portal</span><span class="kv-v mono">{{ relay.rpcPortal }}</span>
              <span class="kv-k">配置文件</span><span class="kv-v mono truncate" :title="relay.configFile">{{ relay.configFile }}</span>
              <span class="kv-k">日志文件</span><span class="kv-v mono truncate" :title="relay.logFile">{{ relay.logFile }}</span>
              <span class="kv-k">累计流量</span>
              <span class="kv-v">
                收 {{ formatBytes(relay.rxBytes) }} / 发 {{ formatBytes(relay.txBytes) }}
                · {{ relay.peerCount }} peers
              </span>
              <span class="kv-k">启动于</span>
              <span class="kv-v">
                {{ relay.startedAt ? formatRelativeTime(relay.startedAt) : '—' }}
                <span class="faint" style="font-size: var(--fs-xs)">
                  （主控已运行 {{ formatDuration(overview?.uptimeSeconds ?? 0) }}）
                </span>
              </span>
            </div>

            <div v-if="relay.lastError" class="err-box">
              <strong>最近错误：</strong>{{ relay.lastError }}
            </div>
            <div v-else class="hint">最近未记录错误。</div>

            <div class="row">
              <RouterLink class="btn btn-sm" to="/console/relay">打开主控中继面板</RouterLink>
              <RouterLink class="btn btn-sm btn-ghost" to="/console/traffic">查看流量归因</RouterLink>
            </div>
          </template>
          <div v-else class="empty">中继未启动或状态未知。</div>
        </section>

        <!-- system 信息块 -->
        <section class="card stack">
          <div class="panel-title">系统信息</div>
          <div v-if="overview" class="kv">
            <span class="kv-k">平台版本</span><span class="kv-v mono">{{ overview.version }}</span>
            <span class="kv-k">EasyTier 核心</span>
            <span class="kv-v mono">{{ overview.easytierVersion ?? '未探测' }}</span>
            <span class="kv-k">Node 版本</span><span class="kv-v mono">{{ overview.system.nodeVersion }}</span>
            <span class="kv-k">运行平台</span><span class="kv-v mono">{{ overview.system.platform }}</span>
            <span class="kv-k">Schema 版本</span><span class="kv-v mono">{{ overview.system.schemaVersion }}</span>
            <span class="kv-k">数据库</span>
            <span class="kv-v mono truncate" :title="overview.system.dbFile">{{ overview.system.dbFile }}</span>
            <span class="kv-k">进程 PID</span><span class="kv-v mono">{{ overview.system.pid }}</span>
            <span class="kv-k">内存占用</span><span class="kv-v mono">{{ overview.system.memoryMb }} MB</span>
            <span class="kv-k">服务端时间</span><span class="kv-v mono">{{ formatDateTime(overview.serverTime) }}</span>
            <span class="kv-k">已运行</span><span class="kv-v">{{ formatDuration(overview.uptimeSeconds) }}</span>
          </div>
        </section>
      </div>

      <!-- 节点表 -->
      <section class="card stack">
        <div class="row-between">
          <div>
            <div class="panel-title">中继节点</div>
            <p class="panel-sub">最多显示前 12 个，完整列表与操作在中继节点页</p>
          </div>
          <RouterLink class="btn btn-sm" to="/console/nodes">全部节点</RouterLink>
        </div>

        <div v-if="nodeRows.length === 0" class="empty">还没有注册任何子节点，当前仅使用主控中继兜底。</div>
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
                  <div class="truncate" style="max-width: 220px">{{ n.name }}</div>
                  <div class="faint mono truncate" style="font-size: var(--fs-xs)" :title="n.endpoint">{{ n.endpoint }}</div>
                </td>
                <td>{{ regionLabel(n.region) }}</td>
                <td><Badge :tone="nodeTone(n.status)" dot>{{ nodeLabel(n.status) }}</Badge></td>
                <td class="table-num">{{ n.peers }} / {{ n.capacityPeers }}</td>
                <td class="table-num">{{ n.rooms }}</td>
                <td class="table-num">{{ formatBitrate(n.rxBps) }} / {{ formatBitrate(n.txBps) }}</td>
                <td class="table-num">{{ n.weight }}</td>
                <td class="muted">{{ formatRelativeTime(n.lastSeenAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 房间表 -->
      <section class="card stack">
        <div class="row-between">
          <div>
            <div class="panel-title">开放中的房间</div>
            <p class="panel-sub">最多显示前 12 个，详情与强制关闭在房间管理页</p>
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
                <td class="truncate" style="max-width: 220px">{{ r.name }}</td>
                <td class="mono">{{ r.code }}</td>
                <td class="truncate" style="max-width: 140px">{{ r.hostDisplayName }}</td>
                <td>{{ regionLabel(r.zone) }}</td>
                <td><Badge :tone="roomTone(r.status)" dot>{{ roomLabel(r.status) }}</Badge></td>
                <td class="table-num">{{ r.onlineMembers }} / {{ r.policy.maxPlayers }}</td>
                <td class="mono">{{ r.subnet }}</td>
                <td class="muted">{{ formatRelativeTime(r.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 审计时间线 -->
      <section class="card stack">
        <div class="row-between">
          <div>
            <div class="panel-title">最近操作</div>
            <p class="panel-sub">最近 15 条审计记录</p>
          </div>
          <RouterLink class="btn btn-sm" to="/console/audit">全部日志</RouterLink>
        </div>

        <div v-if="auditRows.length === 0" class="empty">暂无审计记录。</div>
        <ol v-else class="timeline">
          <li v-for="a in auditRows" :key="a.id">
            <span class="tl-dot" />
            <div class="tl-body">
              <div class="row wrap" style="gap: var(--s-2)">
                <span class="mono tl-action">{{ a.action }}</span>
                <Badge tone="neutral">{{ a.actorType }}</Badge>
                <span class="muted" style="font-size: var(--fs-xs)">{{ a.actorName ?? a.actorId ?? '系统' }}</span>
                <span class="faint" style="font-size: var(--fs-xs); margin-left: auto">
                  {{ formatRelativeTime(a.ts) }}
                </span>
              </div>
              <div v-if="a.targetType" class="faint" style="font-size: var(--fs-xs)">
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
.cards {
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
}
.two {
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
}
.table-wrap {
  overflow-x: auto;
}
.warn-bar {
  padding: var(--s-4);
  border-radius: var(--r-md);
  background: var(--warn-bg);
  border: 1px solid rgba(255, 200, 74, 0.28);
}
.warn-list {
  margin: 0;
  padding-left: 1.1em;
  font-size: var(--fs-sm);
  color: var(--text-dim);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kv {
  display: grid;
  grid-template-columns: 104px minmax(0, 1fr);
  gap: var(--s-2) var(--s-3);
  font-size: var(--fs-sm);
  align-items: baseline;
}
.kv-k {
  color: var(--text-faint);
  font-size: var(--fs-xs);
}
.kv-v {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}
.err-box {
  padding: var(--s-3);
  border-radius: var(--r-sm);
  background: var(--danger-bg);
  border: 1px solid rgba(255, 107, 107, 0.3);
  color: #ffc9c9;
  font-size: var(--fs-xs);
  word-break: break-word;
}
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}
.timeline li {
  display: flex;
  gap: var(--s-3);
  align-items: flex-start;
}
.tl-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--brand);
  margin-top: 6px;
  flex: none;
  box-shadow: 0 0 0 3px rgba(53, 224, 200, 0.14);
}
.tl-body {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tl-action {
  font-size: var(--fs-sm);
  color: var(--text);
}
</style>
