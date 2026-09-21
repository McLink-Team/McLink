<script setup lang="ts">
/**
 * 主控中继面板：运行时状态、生成的 TOML 配置、peers 表、日志尾部与运维动作。
 *
 * 三个动作的影响面差异很大，界面上必须说清楚：
 *  - 手动刷新采样：只读，安全；
 *  - 重启中继：会短暂中断所有房间的连接；
 *  - 下发 ACL：新版可热更新，旧版（不支持 `acl set`）只能靠重启生效。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  Routes,
  Topics,
  formatBitrate,
  formatBytes,
  formatRelativeTime,
  type RelayRuntime,
  type ServerEvent,
} from '@mclink/shared';
import { api, friendlyError } from '../../lib/api.ts';
import { RealtimeClient } from '../../lib/realtime.ts';
import { asArray, asStringList, copyText, formatDateTime, relayWhitelist, reportError } from '../../lib/ui.ts';
import { notifyOk, notifyWarn } from '../../lib/toast.ts';
import Badge from '../../components/Badge.vue';

interface RelayPeer {
  peerId: number;
  hostname: string;
  ipv4: string;
  cost: string;
  latencyMs: number | null;
  lossRate: number | null;
  rxBytes: number;
  txBytes: number;
  tunnelProto: string;
  networkName: string;
}

interface RelayResponse {
  runtime: RelayRuntime;
  configToml: string;
  configFile: string;
  logFile: string;
  cliVersion: string | null;
  coreBin: string;
  cliBin: string;
  peers: RelayPeer[];
  logs: string[];
  /** 旧版主控给空格分隔字符串，新版可能额外给 whitelistPatterns */
  whitelist: string | string[];
  whitelistPatterns?: string | string[];
}

const data = ref<RelayResponse | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const busy = ref<'refresh' | 'restart' | 'acl' | null>(null);

const aclText = ref('');
const aclError = ref<string | null>(null);
const logEl = ref<HTMLElement | null>(null);
const autoScroll = ref(true);

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await api.get<RelayResponse>(Routes.adminRelay);
    error.value = null;
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------- 日志滚动 */

async function scrollLogsToEnd(): Promise<void> {
  if (!autoScroll.value) return;
  await nextTick();
  const el = logEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

watch(
  () => data.value?.logs.length ?? 0,
  () => {
    void scrollLogsToEnd();
  },
);

/* --------------------------------------------------------------- 实时 */

let client: RealtimeClient | null = null;
let lastRefresh = 0;

onMounted(() => {
  void load().then(() => scrollLogsToEnd());
  client = new RealtimeClient({
    topics: [Topics.traffic],
    onEvent: (event: ServerEvent) => {
      if (event.type !== 'relay.update') return;
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

const runtime = computed(() => data.value?.runtime ?? null);
const peers = computed(() => asArray(data.value?.peers));
const logs = computed(() => asStringList(data.value?.logs));
const configToml = computed(() => data.value?.configToml ?? '');
/** 白名单可能是空格分隔字符串，直接 .join() 会白屏 */
const whitelistPatterns = computed(() => relayWhitelist(data.value));
/** 外来网络的实时速率合计（字段缺失时按 0 处理，不让 reduce 抛错） */
const foreignRxBps = computed(() => asArray(runtime.value?.foreignNetworks).reduce((acc, n) => acc + (n.rxBps ?? 0), 0));
const foreignTxBps = computed(() => asArray(runtime.value?.foreignNetworks).reduce((acc, n) => acc + (n.txBps ?? 0), 0));

/* --------------------------------------------------------------- 动作 */

async function refreshSample(): Promise<void> {
  busy.value = 'refresh';
  try {
    const result = await api.post<{ ok: boolean; peers: number; foreignNetworks: number }>('/admin/relay/refresh');
    notifyOk(result.ok ? `采样完成：${result.peers} peers / ${result.foreignNetworks} 外来网络` : '采样未成功（CLI 不可用或中继未运行）');
    await load();
    await scrollLogsToEnd();
  } catch (err) {
    reportError(err);
  } finally {
    busy.value = null;
  }
}

async function restartRelay(): Promise<void> {
  if (!confirm('确定重启主控中继？所有房间的连接会短暂中断（通常数秒），玩家客户端会自动重连。')) return;
  busy.value = 'restart';
  try {
    await api.post<RelayRuntime>(Routes.adminRelayRestart);
    notifyWarn('中继已重启，正在等待运行状态');
    await load();
  } catch (err) {
    reportError(err);
  } finally {
    busy.value = null;
  }
}

async function applyAcl(): Promise<void> {
  const text = aclText.value.trim();
  aclError.value = null;
  if (!text) {
    aclError.value = 'ACL 内容不能为空';
    return;
  }
  if (!text.includes('[acl.acl_v1]')) {
    aclError.value = 'ACL 必须包含 [acl.acl_v1] 段，否则 EasyTier 无法解析';
    return;
  }
  if (!confirm('确定下发这份 ACL？它会立即覆盖主控中继当前的 ACL 配置。')) return;

  busy.value = 'acl';
  try {
    const result = await api.post<{ ok: boolean; mode: 'hot' | 'restart' }>(Routes.adminRelayAcl, { aclToml: text });
    if (result.mode === 'restart') {
      notifyWarn('当前 EasyTier 版本不支持热更新，已通过重启生效');
    } else {
      notifyOk('ACL 已热更新，未中断连接');
    }
    await load();
  } catch (err) {
    aclError.value = reportError(err);
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <div class="stack" style="gap: var(--s-5)">
    <div class="row-between wrap">
      <div>
        <div class="panel-title">主控中继</div>
        <p class="panel-sub">
          单端口共享中继：所有房间复用同一个监听端口，靠网络名白名单决定是否转发，
          因此新增/关闭房间都不需要重启进程。
        </p>
      </div>
      <div class="row">
        <button class="btn" type="button" :disabled="loading" @click="load">
          <span v-if="loading" class="spinner" />
          刷新
        </button>
        <button class="btn" type="button" :disabled="busy !== null" @click="refreshSample">
          <span v-if="busy === 'refresh'" class="spinner" />
          手动刷新采样
        </button>
        <button class="btn btn-danger" type="button" :disabled="busy !== null" @click="restartRelay">
          <span v-if="busy === 'restart'" class="spinner" />
          重启中继
        </button>
      </div>
    </div>

    <div v-if="loading && !data" class="stack">
      <div class="skeleton" style="height: 140px" />
      <div class="skeleton" style="height: 220px" />
    </div>

    <div v-else-if="error && !data" class="card">
      <div class="row-between">
        <div>
          <div class="panel-title" style="font-size: var(--fs-base)">中继状态加载失败</div>
          <p class="panel-sub">{{ error }}</p>
        </div>
        <button class="btn" type="button" @click="load">重试</button>
      </div>
    </div>

    <template v-else-if="data">
      <div v-if="error" class="warn-bar">
        <div class="row wrap" style="gap: var(--s-3)">
          <Badge tone="danger">刷新失败</Badge>
          <span class="grow">{{ error }}</span>
          <button class="btn btn-sm" type="button" @click="load">重试</button>
        </div>
      </div>

      <!-- 运行时 -->
      <section class="card stack">
        <div class="row-between">
          <div class="panel-title" style="font-size: var(--fs-base)">运行时状态</div>
          <div class="row">
            <Badge :tone="runtime?.running ? 'ok' : 'danger'" dot :pulse="Boolean(runtime?.running)">
              {{ runtime?.running ? '运行中' : '未运行' }}
            </Badge>
            <Badge :tone="data.cliVersion ? 'ok' : 'warn'">
              CLI {{ data.cliVersion ?? '不可用' }}
            </Badge>
          </div>
        </div>

        <div v-if="runtime" class="kv">
          <span class="kv-k">监听地址</span><span class="kv-v mono">{{ runtime.listen }}</span>
          <span class="kv-k">网络名</span><span class="kv-v mono">{{ runtime.networkName }}</span>
          <span class="kv-k">peer 数</span><span class="kv-v mono">{{ runtime.peerCount }}</span>
          <span class="kv-k">累计流量</span>
          <span class="kv-v">
            收 {{ formatBytes(runtime.rxBytes) }} / 发 {{ formatBytes(runtime.txBytes) }}
          </span>
          <span class="kv-k">实时速率</span>
          <span class="kv-v">{{ formatBitrate(foreignRxBps) }} / {{ formatBitrate(foreignTxBps) }}</span>
          <span class="kv-k">启动时间</span>
          <span class="kv-v">{{ runtime.startedAt ? formatDateTime(runtime.startedAt) : '—' }}</span>
          <span class="kv-k">白名单</span>
          <span class="kv-v mono truncate" :title="whitelistPatterns.join(', ')">
            {{ whitelistPatterns.length > 0 ? whitelistPatterns.join(', ') : '（未配置，任何网络都会被拒绝转发）' }}
          </span>
          <span class="kv-k">核心二进制</span><span class="kv-v mono truncate" :title="data.coreBin">{{ data.coreBin }}</span>
          <span class="kv-k">CLI 二进制</span><span class="kv-v mono truncate" :title="data.cliBin">{{ data.cliBin }}</span>
          <span class="kv-k">配置文件</span>
          <span class="kv-v mono truncate" :title="data.configFile">
            {{ data.configFile }}
            <button class="btn btn-sm btn-ghost" type="button" @click="copyText(data.configFile, '配置路径')">复制</button>
          </span>
          <span class="kv-k">日志文件</span>
          <span class="kv-v mono truncate" :title="data.logFile">
            {{ data.logFile }}
            <button class="btn btn-sm btn-ghost" type="button" @click="copyText(data.logFile, '日志路径')">复制</button>
          </span>
        </div>

        <div v-if="runtime?.lastError" class="err-box">
          <strong>最后错误：</strong>{{ runtime.lastError }}
        </div>
        <p v-else class="hint">
          未记录到错误<template v-if="runtime?.startedAt">；中继启动于 {{ formatRelativeTime(runtime.startedAt) }}</template>。
        </p>
      </section>

      <!-- 配置 -->
      <section class="card stack">
        <div class="row-between">
          <div>
            <div class="panel-title" style="font-size: var(--fs-base)">生成的 EasyTier 配置（relay.toml）</div>
            <p class="panel-sub">由主控按环境变量与平台设置渲染，只读；修改请改环境变量或平台设置。</p>
          </div>
          <button class="btn btn-sm" type="button" @click="copyText(configToml, '配置内容')">复制全文</button>
        </div>
        <pre class="code-block">{{ configToml || '（无配置内容）' }}</pre>
      </section>

      <!-- peers -->
      <section class="card stack">
        <div class="panel-title" style="font-size: var(--fs-base)">已连接 peers（{{ peers.length }}）</div>
        <div v-if="peers.length === 0" class="empty">
          暂无 peer 采样数据。若中继正在运行但没有数据，通常是 easytier-cli 不可用。
        </div>
        <div v-else class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th class="table-num">ID</th>
                <th>主机名</th>
                <th>IPv4</th>
                <th>网络名</th>
                <th>隧道</th>
                <th class="table-num">延迟</th>
                <th class="table-num">丢包</th>
                <th class="table-num">接收</th>
                <th class="table-num">发送</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in peers" :key="p.peerId">
                <td class="table-num">{{ p.peerId }}</td>
                <td class="truncate" style="max-width: 200px">{{ p.hostname || '—' }}</td>
                <td class="mono" style="font-size: var(--fs-xs)">{{ p.ipv4 || '—' }}</td>
                <td class="mono truncate" style="font-size: var(--fs-xs); max-width: 220px" :title="p.networkName">
                  {{ p.networkName || '—' }}
                </td>
                <td class="muted" style="font-size: var(--fs-xs)">{{ p.tunnelProto || '—' }}</td>
                <td class="table-num">{{ p.latencyMs === null ? '—' : `${p.latencyMs} ms` }}</td>
                <td class="table-num">{{ p.lossRate === null ? '—' : p.lossRate }}</td>
                <td class="table-num">{{ formatBytes(p.rxBytes) }}</td>
                <td class="table-num">{{ formatBytes(p.txBytes) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ACL 下发 -->
      <section class="card stack">
        <div>
          <div class="panel-title" style="font-size: var(--fs-base)">下发自定义 ACL</div>
          <p class="panel-sub">
            文本必须包含 <span class="mono">[acl.acl_v1]</span> 段。支持 <span class="mono">acl set</span> 的 EasyTier
            版本会热更新（不中断连接）；旧版本会写入配置并重启中继生效。
          </p>
        </div>
        <textarea
          v-model="aclText"
          class="textarea mono"
          rows="8"
          placeholder="[acl.acl_v1]
default_action = 1"
        />
        <div v-if="aclError" class="err-box">{{ aclError }}</div>
        <div class="row-between wrap">
          <span class="hint">留空不会清空 ACL；如需恢复默认守卫规则，请重启中继并清空自定义 ACL。</span>
          <div class="row">
            <button class="btn btn-ghost" type="button" @click="aclText = ''">清空输入</button>
            <button class="btn btn-primary" type="button" :disabled="busy !== null" @click="applyAcl">
              <span v-if="busy === 'acl'" class="spinner" />
              下发 ACL
            </button>
          </div>
        </div>
      </section>

      <!-- 日志 -->
      <section class="card stack">
        <div class="row-between">
          <div>
            <div class="panel-title" style="font-size: var(--fs-base)">中继日志尾部（{{ logs.length }} 行）</div>
            <p class="panel-sub">读取进程内最近的输出，滚动到底部查看最新。</p>
          </div>
          <div class="row">
            <label class="switch">
              <input v-model="autoScroll" type="checkbox" />
              <span>自动滚到底</span>
            </label>
            <button class="btn btn-sm" type="button" @click="scrollLogsToEnd">滚到底部</button>
            <button class="btn btn-sm" type="button" @click="copyText(logs.join('\n'), '日志内容')">复制日志</button>
          </div>
        </div>
        <pre v-if="logs.length > 0" ref="logEl" class="log-block">{{ logs.join('\n') }}</pre>
        <div v-else class="empty">暂无日志输出。</div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.table-wrap {
  overflow-x: auto;
}
.kv {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
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
.code-block {
  margin: 0;
  padding: var(--s-3);
  border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--bg-0) 60%, transparent);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: var(--fs-xs);
  max-height: 320px;
  overflow: auto;
  white-space: pre;
}
.log-block {
  margin: 0;
  padding: var(--s-3);
  border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--bg-0) 85%, transparent);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: var(--fs-xs);
  line-height: 1.5;
  height: 300px;
  overflow: auto;
  white-space: pre;
}
.warn-bar {
  padding: var(--s-3) var(--s-4);
  border-radius: var(--r-md);
  background: var(--warn-bg);
  border: 1px solid color-mix(in srgb, var(--warn) 28%, transparent);
  font-size: var(--fs-sm);
}
.err-box {
  padding: var(--s-3);
  border-radius: var(--r-sm);
  background: var(--danger-bg);
  border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
  color: var(--danger);
  font-size: var(--fs-xs);
  word-break: break-word;
}
</style>
