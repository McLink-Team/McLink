<script setup lang="ts">
/**
 * 连接诊断：把「现在到底连成什么样」摊开，并给出能照着做的建议。
 *
 * 数据来源：
 *   - window.mclink.core.peers()      → easytier-cli peer list（节点、链路类型、延迟、隧道协议、NAT）
 *   - window.mclink.core.cli(node info) → 本机 EasyTier 节点信息（虚拟 IP、监听端口、STUN/NAT）
 *
 * 关于 NAT：`stun_info.udp_nat_type` 是 EasyTier 自己的数字类型码，
 * 平台没有官方映射表，因此这里原样显示数字并注明它是「EasyTier NAT 类型码」；
 * 同时把 CLI 自己在 `peer list` 里给出的类型名（实测 udp_nat_type=8 ↔ "SymmetricEasyInc"）
 * 一并展示 —— 那是 EasyTier 的输出，不是我们编的翻译。
 */
import { computed, onMounted, ref } from 'vue';
import { formatBytes, formatRelativeTime } from '@mclink/shared';
import { friendlyError } from '../lib/api.ts';
import { clientState } from '../lib/store.ts';
import {
  extractNodeFacts,
  linkKind,
  listenPortsOf,
  parseLocalNatType,
  parsePeers,
  type NodeFacts,
  type PeerView,
} from '../lib/easytier-parse.ts';
import type { AppInfo } from '../lib/bridge.ts';

interface Advice {
  level: 'ok' | 'warn' | 'danger' | 'info';
  text: string;
}

const peers = ref<PeerView[]>([]);
const facts = ref<NodeFacts | null>(null);
/** EasyTier CLI 自己给出的本机 NAT 类型名 */
const localNatName = ref<string | null>(null);
const info = ref<AppInfo | null>(null);
const loading = ref(false);
const error = ref('');
const cliError = ref('');
const checkedAt = ref(0);
const now = ref(Date.now());

const virtualIp = computed(() => clientState.session?.virtualIp ?? facts.value?.virtualIp ?? null);
const coreState = computed(() => clientState.coreStatus?.state ?? 'stopped');

/** 本机监听端口：优先用 EasyTier 自己报的监听地址，取不到就退回客户端选的端口 */
const listenPorts = computed<string[]>(() => {
  const ports = listenPortsOf(facts.value?.listenUrls ?? []);
  if (ports.length > 0) return ports;
  const chosen = clientState.listenPort;
  return chosen > 0 ? [String(chosen)] : [];
});

const remotePeers = computed(() => peers.value.filter((p) => linkKind(p.cost) !== 'local'));
const directPeers = computed(() => remotePeers.value.filter((p) => linkKind(p.cost) === 'p2p'));
const relayPeers = computed(() => remotePeers.value.filter((p) => linkKind(p.cost) !== 'p2p'));
const slowPeers = computed(() => remotePeers.value.filter((p) => p.latencyMs !== null && p.latencyMs > 150));

const advice = computed<Advice[]>(() => {
  const list: Advice[] = [];
  if (coreState.value !== 'running') {
    list.push({
      level: 'danger',
      text: '本地 EasyTier 核心当前不是「运行中」。先回到房间页点「刷新状态」；如果一直起不来，去「日志」标签看 easytier-core 的报错。',
    });
  }
  if (info.value && !info.value.elevated) {
    list.push({
      level: 'warn',
      text: '当前不是以管理员身份运行。Windows 上创建虚拟网卡（wintun）需要管理员权限，否则成员之间连不通 —— 可以在「设置」里点「以管理员身份重启」。',
    });
  }
  if (remotePeers.value.length === 0) {
    list.push({
      level: 'warn',
      text: '一个节点都没发现：① 确认右上角主控连接正常（能刷新成员列表）；② 确认本地核心是运行中；③ 确认其它成员真的进了同一个房间；④ 确认已提权。全都正常还看不到，多半是防火墙拦了 EasyTier 的 UDP。',
    });
  } else if (directPeers.value.length === 0) {
    list.push({
      level: 'warn',
      text: `现在 ${remotePeers.value.length} 个节点全部经中继转发：说明 NAT 较严格或被防火墙拦住。可以让房主在「房间规则」里把「允许 P2P 直连」打开，并在 Windows 防火墙里放行 easytier-core 的 UDP。`,
    });
  } else {
    list.push({
      level: 'ok',
      text: `已有 ${directPeers.value.length} 个节点 P2P 直连（延迟更低，也不占用中转带宽）。`,
    });
  }
  if (slowPeers.value.length > 0) {
    const worst = Math.max(...slowPeers.value.map((p) => p.latencyMs ?? 0));
    list.push({
      level: 'warn',
      text: `有 ${slowPeers.value.length} 个节点延迟超过 150ms（最高 ${worst.toFixed(0)} ms）。建议换一个更近的区域：房主可以在「房间规则」里改区域，或者关掉房间后重新建房时选更近的大区。`,
    });
  }
  if (facts.value && facts.value.natUdp !== null) {
    list.push({
      level: 'info',
      text: `本机 EasyTier NAT 类型码：${facts.value.natUdp}（平台未做数字到名称的映射，具体含义以 EasyTier 官方文档为准）。${
        localNatName.value ? `easytier-cli 报出的类型名是 ${localNatName.value}。` : ''
      }${
        directPeers.value.length === 0 && remotePeers.value.length > 0
          ? '结合「全部经中继」的现状，穿透确实可能受限。'
          : ''
      }`,
    });
  } else if (localNatName.value) {
    list.push({
      level: 'info',
      text: `easytier-cli 报出的本机 NAT 类型名：${localNatName.value}（node info 里没有读到 udp_nat_type 数字）。`,
    });
  } else if (remotePeers.value.length > 0) {
    list.push({
      level: 'info',
      text: '没有读到 STUN/NAT 信息（可能未启用 STUN，或当前 EasyTier 版本不返回该字段）。这不影响联机，只影响这里的诊断细节。',
    });
  }
  return list;
});

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = '';
  cliError.value = '';
  try {
    const [peerRes, nodeRes] = await Promise.all([
      window.mclink.core.peers(),
      window.mclink.core.cli(['node', 'info']),
    ]);
    if (!peerRes.ok) throw new Error(peerRes.error ?? 'easytier-cli peer list 调用失败');
    peers.value = parsePeers(peerRes.data);
    localNatName.value = parseLocalNatType(peerRes.data);
    if (nodeRes.ok) {
      facts.value = extractNodeFacts(nodeRes.data);
    } else {
      facts.value = null;
      cliError.value = nodeRes.error ?? 'easytier-cli node info 调用失败';
    }
    checkedAt.value = Date.now();
    now.value = checkedAt.value;
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  info.value = await window.mclink.info().catch(() => null);
  await refresh();
});
</script>

<template>
  <div class="card">
    <div class="row-between wrap" style="margin-bottom: 10px">
      <div>
        <div style="font-weight: 620">连接诊断</div>
        <div class="hint">
          <template v-if="checkedAt > 0">上次检测：{{ formatRelativeTime(checkedAt, now) }}</template>
          <template v-else>检查直连/中继、延迟、NAT 与监听端口</template>
        </div>
      </div>
      <button class="btn btn-sm" :disabled="loading" @click="refresh()">
        <span v-if="loading" class="spinner" />
        <span>重新检测</span>
      </button>
    </div>

    <!-- 三态：加载中 -->
    <div v-if="loading && checkedAt === 0" class="row" style="padding: var(--s-4) 0">
      <span class="spinner" />
      <span class="muted">正在查询 easytier-cli…</span>
    </div>

    <!-- 三态：请求失败 -->
    <div v-else-if="error" class="stack">
      <div class="alert alert-danger">
        <span class="grow">诊断失败：{{ error }}</span>
      </div>
      <div class="hint">常见原因：easytier-core 还没启动（没进房间 / 核心启动失败），或 easytier-cli 缺失。</div>
      <button class="btn btn-sm" @click="refresh()">重试</button>
    </div>

    <template v-else>
      <div class="grid-3" style="margin-bottom: 12px">
        <div>
          <div class="faint" style="font-size: var(--fs-xs)">P2P 直连节点</div>
          <div class="mono">{{ directPeers.length }} / {{ remotePeers.length }}</div>
        </div>
        <div>
          <div class="faint" style="font-size: var(--fs-xs)">经中继节点</div>
          <div class="mono">{{ relayPeers.length }}</div>
        </div>
        <div>
          <div class="faint" style="font-size: var(--fs-xs)">虚拟 IP</div>
          <div class="mono">{{ virtualIp ?? '未分配' }}</div>
        </div>
        <div>
          <div class="faint" style="font-size: var(--fs-xs)">本机监听端口</div>
          <div class="mono">{{ listenPorts.length > 0 ? listenPorts.join(' / ') : '未知' }}</div>
        </div>
        <div>
          <div class="faint" style="font-size: var(--fs-xs)">核心状态</div>
          <div class="mono">{{ coreState }}</div>
        </div>
        <div>
          <div class="faint" style="font-size: var(--fs-xs)">权限</div>
          <div class="mono">{{ info ? (info.elevated ? '已提权' : '未提权') : '未知' }}</div>
        </div>
      </div>

      <div v-if="facts" class="hint" style="margin-bottom: 10px">
        <span class="mono">peer_id {{ facts.peerId ?? '-' }}</span> ·
        <span class="mono">host {{ facts.hostname ?? '-' }}</span> ·
        <span class="mono">公网 IP {{ facts.publicIp ?? '未知' }}</span> ·
        <span class="mono">EasyTier NAT 类型码 UDP {{ facts.natUdp ?? '-' }} / TCP {{ facts.natTcp ?? '-' }}</span>
        <template v-if="localNatName"> · <span class="mono">CLI 报的类型名 {{ localNatName }}</span></template>
      </div>
      <div v-else-if="cliError" class="hint" style="margin-bottom: 10px; color: var(--warn)">
        本机节点信息读取失败：{{ cliError }}（下面的节点列表仍然可用）
      </div>

      <!-- 三态：空数据 -->
      <div v-if="peers.length === 0" class="empty">
        还没发现任何节点。等房间里的其它成员连上后，这里会显示他们的链路类型与延迟。
      </div>
      <table v-else class="table">
        <thead>
          <tr>
            <th>节点</th>
            <th>虚拟地址</th>
            <th>链路</th>
            <th>隧道协议</th>
            <th>NAT 类型</th>
            <th class="table-num">延迟</th>
            <th class="table-num">流量</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in peers" :key="`${p.ipv4}-${p.hostname}-${p.cost}`">
            <td class="truncate" style="max-width: 150px">{{ p.hostname || '-' }}</td>
            <td class="mono">{{ p.ipv4 || '-' }}</td>
            <td>
              <span class="badge" :class="linkKind(p.cost) === 'p2p' ? 'badge-ok' : 'badge-neutral'">
                {{ linkKind(p.cost) === 'p2p' ? 'P2P 直连' : linkKind(p.cost) === 'local' ? '本机' : linkKind(p.cost) === 'relay' ? '经中继' : p.cost || '未知' }}
              </span>
            </td>
            <td class="mono truncate" style="max-width: 120px">{{ p.tunnelProto || '-' }}</td>
            <td class="mono truncate" style="max-width: 130px">{{ p.natType || '-' }}</td>
            <td class="table-num">{{ p.latencyMs === null ? '-' : `${p.latencyMs.toFixed(1)} ms` }}</td>
            <td class="table-num">{{ formatBytes(p.rxBytes + p.txBytes) }}</td>
          </tr>
        </tbody>
      </table>

      <div class="stack" style="margin-top: 12px; gap: 6px">
        <div
          v-for="(a, i) in advice"
          :key="i"
          class="advice"
          :class="a.level === 'ok' ? 'advice-ok' : a.level === 'warn' ? 'advice-warn' : a.level === 'danger' ? 'advice-danger' : 'advice-info'"
        >
          {{ a.text }}
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.wrap {
  flex-wrap: wrap;
}
.advice {
  font-size: var(--fs-sm);
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--surface);
}
.advice-ok {
  border-color: rgba(61, 220, 151, 0.3);
  background: var(--ok-bg);
}
.advice-warn {
  border-color: rgba(255, 200, 74, 0.3);
  background: var(--warn-bg);
}
.advice-danger {
  border-color: rgba(255, 107, 107, 0.3);
  background: var(--danger-bg);
}
.advice-info {
  border-color: rgba(92, 200, 255, 0.28);
  background: var(--info-bg);
}
</style>
