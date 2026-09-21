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
  /** 中继没在运行时用来解释"为什么"（旧版主控没有这个字段） */
  diagnostics?: {
    autoStart: boolean;
    coreExists: boolean;
    cliExists: boolean;
    relayPort: number;
    warnings: string[];
  };
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
  <div class="console-page">
    <header class="console-head">
      <div class="console-head-text">
        <h1 class="console-head-title">主控中继</h1>
        <p class="console-head-sub">
          单端口共享中继：所有房间复用同一个监听端口，靠网络名白名单决定是否转发，
          因此新增/关闭房间都不需要重启进程。
        </p>
      </div>
      <div class="console-head-actions">
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
    </header>

    <div v-if="loading && !data" class="stack">
      <div class="skeleton" style="height: 130px" />
      <div class="skeleton" style="height: 200px" />
    </div>

    <section v-else-if="error && !data" class="console-section">
      <div class="console-section-head">
        <div class="console-section-text">
          <div class="console-sub-title">中继状态加载失败</div>
          <p class="console-section-note">{{ error }}</p>
        </div>
        <button class="btn" type="button" @click="load">重试</button>
      </div>
    </section>

    <template v-else-if="data">
      <div v-if="error" class="notice notice-warn">
        <Badge tone="danger">刷新失败</Badge>
        <span class="notice-body">{{ error }}</span>
        <button class="btn btn-sm" type="button" @click="load">重试</button>
      </div>

      <!-- 运行时 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">运行时状态</h2>
            <p class="console-section-note">数据来自进程内采样，手动刷新会立即向 easytier-cli 拉一次。</p>
          </div>
          <div class="console-toolbar">
            <Badge :tone="runtime?.running ? 'ok' : 'danger'" dot :pulse="Boolean(runtime?.running)">
              {{ runtime?.running ? '运行中' : '未运行' }}
            </Badge>
            <Badge :tone="data.cliVersion ? 'ok' : 'warn'">CLI {{ data.cliVersion ?? '不可用' }}</Badge>
          </div>
        </div>

        <div v-if="runtime" class="kv">
          <span class="kv-k">监听地址</span><span class="kv-v mono">{{ runtime.listen }}</span>
          <span class="kv-k">网络名</span><span class="kv-v mono">{{ runtime.networkName }}</span>
          <span class="kv-k">peer 数</span><span class="kv-v mono">{{ runtime.peerCount }}</span>
          <span class="kv-k">累计流量</span>
          <span class="kv-v">收 {{ formatBytes(runtime.rxBytes) }} / 发 {{ formatBytes(runtime.txBytes) }}</span>
          <span class="kv-k">实时速率</span>
          <span class="kv-v mono">{{ formatBitrate(foreignRxBps) }} / {{ formatBitrate(foreignTxBps) }}</span>
          <span class="kv-k">启动时间</span>
          <span class="kv-v">{{ runtime.startedAt ? formatDateTime(runtime.startedAt) : '未记录' }}</span>
          <span class="kv-k">白名单</span>
          <span class="kv-v mono wrap-anywhere">
            {{ whitelistPatterns.length > 0 ? whitelistPatterns.join(', ') : '（未配置，任何网络都会被拒绝转发）' }}
          </span>
          <span class="kv-k">核心二进制</span><span class="kv-v mono wrap-anywhere">{{ data.coreBin }}</span>
          <span class="kv-k">CLI 二进制</span><span class="kv-v mono wrap-anywhere">{{ data.cliBin }}</span>
          <span class="kv-k">配置文件</span>
          <span class="kv-v mono wrap-anywhere">
            <span>{{ data.configFile }}</span>
            <button class="btn btn-sm btn-ghost" type="button" @click="copyText(data.configFile, '配置路径')">复制</button>
          </span>
          <span class="kv-k">日志文件</span>
          <span class="kv-v mono wrap-anywhere">
            <span>{{ data.logFile }}</span>
            <button class="btn btn-sm btn-ghost" type="button" @click="copyText(data.logFile, '日志路径')">复制</button>
          </span>
        </div>

        <div v-if="runtime?.lastError" class="notice notice-danger relay-notice">
          <strong>最后错误：</strong>{{ runtime.lastError }}
        </div>

        <!--
          中继没在运行时把"为什么"直接讲出来。
          之前这里只有一个「未运行」的徽章：主控找不到 easytier-core 时只在日志里写了一行，
          控制台上看不出任何线索（实测有人因此以为是"需要另外部署一个中继"）。
        -->
        <div v-if="runtime && !runtime.running" class="notice notice-warn relay-notice">
          <strong>中继未运行</strong>
          <ul class="relay-why">
            <li v-if="data.diagnostics && !data.diagnostics.autoStart">
              主控中继被停用了（安装时用了 <span class="mono">--no-relay</span>，或环境变量
              <span class="mono">MCLINK_AUTOSTART_RELAY=false</span>）。
              此时房间会完全依赖子节点；没有子节点就建不了房。
              想启用：把该变量改成 <span class="mono">true</span> 后 <span class="mono"
                >systemctl restart mclink-server</span
              >。
            </li>
            <li v-else-if="data.diagnostics && !data.diagnostics.coreExists">
              找不到 <span class="mono">easytier-core</span>：主控在该路径下没有找到可执行文件
              （见下方「核心二进制」）。把 Linux 版二进制放进去，或用
              <span class="mono">MCLINK_ET_CORE</span> 指向已有路径，然后重启主控。
              <br />
              最快的办法：在开发机执行 <span class="mono">pnpm fetch:easytier --all</span>，
              把 <span class="mono">deploy/vendor/linux-x86_64/</span> 整个目录拷到主控的
              <span class="mono">vendor/easytier/</span>，再
              <span class="mono">sudo systemctl restart mclink-server</span>。
            </li>
            <li v-else-if="!data.cliVersion">
              找不到 <span class="mono">easytier-cli</span>：中继本身可能能起来，但流量统计、
              ACL 下发与 peer 列表都会不可用（见下方「CLI 二进制」）。
            </li>
            <li v-else>进程未处于运行状态，请查看下方日志或稍后重试。</li>
          </ul>
          <div v-if="data.diagnostics && data.diagnostics.warnings.length > 0" class="relay-warnings">
            <div v-for="(w, i) in data.diagnostics.warnings" :key="i" class="mono wrap-anywhere">
              {{ w }}
            </div>
          </div>
        </div>
        <p v-else class="hint hint-row">
          未记录到错误<template v-if="runtime?.startedAt">；中继启动于 {{ formatRelativeTime(runtime.startedAt) }}</template>。
        </p>
      </section>

      <!-- 配置 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">生成的 EasyTier 配置（relay.toml）</h2>
            <p class="console-section-note">由主控按环境变量与平台设置渲染，只读；修改请改环境变量或平台设置。</p>
          </div>
          <button class="btn btn-sm" type="button" @click="copyText(configToml, '配置内容')">复制全文</button>
        </div>
        <pre class="code-block code-block-lg">{{ configToml || '（无配置内容）' }}</pre>
      </section>

      <!-- peers -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">已连接 peers（{{ peers.length }}）</h2>
            <p class="console-section-note">当前中继上看到的对端与隧道信息。</p>
          </div>
        </div>
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
                <td v-if="p.hostname" class="wrap-anywhere">{{ p.hostname }}</td>
                <td v-else class="cell-void">未上报</td>
                <td v-if="p.ipv4" class="mono cell-sub">{{ p.ipv4 }}</td>
                <td v-else class="cell-void">未上报</td>
                <td v-if="p.networkName" class="mono cell-sub">{{ p.networkName }}</td>
                <td v-else class="cell-void">未上报</td>
                <td v-if="p.tunnelProto" class="cell-sub">{{ p.tunnelProto }}</td>
                <td v-else class="cell-void">未协商</td>
                <td class="table-num">{{ p.latencyMs === null ? '未测得' : `${p.latencyMs} ms` }}</td>
                <td class="table-num">{{ p.lossRate === null ? '未测得' : p.lossRate }}</td>
                <td class="table-num">{{ formatBytes(p.rxBytes) }}</td>
                <td class="table-num">{{ formatBytes(p.txBytes) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ACL 下发 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">下发自定义 ACL</h2>
            <p class="console-section-note">
              文本必须包含 <span class="mono">[acl.acl_v1]</span> 段。支持 <span class="mono">acl set</span> 的 EasyTier
              版本会热更新（不中断连接）；旧版本会写入配置并重启中继生效。
            </p>
          </div>
        </div>
        <textarea
          v-model="aclText"
          class="textarea mono acl-input"
          rows="8"
          placeholder="[acl.acl_v1]
default_action = 1"
        />
        <div v-if="aclError" class="notice notice-danger relay-notice">{{ aclError }}</div>
        <div class="acl-foot">
          <span class="hint hint-measure">留空不会清空 ACL；如需恢复默认守卫规则，请重启中继并清空自定义 ACL。</span>
          <div class="console-toolbar">
            <button class="btn btn-ghost" type="button" @click="aclText = ''">清空输入</button>
            <button class="btn btn-primary" type="button" :disabled="busy !== null" @click="applyAcl">
              <span v-if="busy === 'acl'" class="spinner" />
              下发 ACL
            </button>
          </div>
        </div>
      </section>

      <!-- 日志 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">中继日志尾部（{{ logs.length }} 行）</h2>
            <p class="console-section-note">读取进程内最近的输出，滚动到底部查看最新。</p>
          </div>
          <div class="console-toolbar">
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
.relay-notice {
  margin-top: var(--s-4);
}
/* 「为什么没在运行」的条目：贴左边线、留出行距，避免一坨文字糊在一起 */
.relay-why {
  margin: var(--s-2) 0 0;
  padding-left: 1.1em;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  font-size: var(--fs-sm);
  line-height: var(--lh-snug);
}
.relay-warnings {
  margin-top: var(--s-3);
  padding-top: var(--s-2);
  border-top: 1px solid var(--rule-faint);
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--fs-xs);
  color: var(--paper-dim);
}
.hint-row {
  margin-top: var(--s-4);
}
.cell-void {
  font-size: var(--fs-xs);
  color: var(--paper-faint);
}
.acl-input {
  margin-bottom: var(--s-3);
}
.acl-foot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--s-4);
  flex-wrap: wrap;
}
.hint-measure {
  max-width: 66ch;
}
.notice-body {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
