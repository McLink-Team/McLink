<script setup lang="ts">
/**
 * 中继节点管理：筛选、编辑、禁用/启用、删除，以及签发子节点注册密钥。
 * 节点一旦注册就会通过 agent 心跳上报 peer 数与实时速率，这里只做展示与调度元数据维护。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import {
  REGIONS,
  Routes,
  formatBitrate,
  formatRelativeTime,
  regionLabel,
  type NodeStatus,
  type RelayNode,
} from '@mclink/shared';
import { api, friendlyError } from '../../lib/api.ts';
import { asArray, asStringList, copyText, formatDateTime, nodeLabel, nodeTone, reportError, toInt } from '../../lib/ui.ts';
import { notifyOk } from '../../lib/toast.ts';
import Badge from '../../components/Badge.vue';

interface RegionAvailability {
  region: string;
  online: number;
  total: number;
  peers: number;
  capacity: number;
}

interface EnrollKeyInfo {
  key: string;
  note: string | null;
  createdAt: string;
  usedAt: string | null;
  usedBy: string | null;
  revoked: boolean;
}

interface EnrollKeyResult {
  enrollKey: string;
  note: string | null;
  createdAt: string;
  command: string;
}

const nodes = ref<RelayNode[]>([]);
const availability = ref<RegionAvailability[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const busyId = ref<string | null>(null);

const filters = reactive({
  region: '',
  status: '',
  search: '',
});

const statusOptions: Array<{ value: NodeStatus; label: string }> = [
  { value: 'online', label: '在线' },
  { value: 'degraded', label: '降级' },
  { value: 'offline', label: '离线' },
  { value: 'pending', label: '待审核' },
  { value: 'disabled', label: '已禁用' },
];

/* ------------------------------------------------------------- 数据加载 */

async function load(): Promise<void> {
  loading.value = true;
  try {
    const query: Record<string, string> = {};
    if (filters.region) query.region = filters.region;
    if (filters.status) query.status = filters.status;
    if (filters.search.trim()) query.search = filters.search.trim();
    const [list, regions] = await Promise.all([
      api.get<RelayNode[]>(Routes.adminNodes, { query }),
      api.get<RegionAvailability[]>('/admin/nodes/regions'),
    ]);
    nodes.value = asArray(list);
    availability.value = asArray(regions);
    error.value = null;
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});

function resetFilters(): void {
  filters.region = '';
  filters.status = '';
  filters.search = '';
  void load();
}

const totalOnline = computed(() => availability.value.reduce((acc, r) => acc + r.online, 0));
const totalPeers = computed(() => availability.value.reduce((acc, r) => acc + r.peers, 0));
const totalCapacity = computed(() => availability.value.reduce((acc, r) => acc + r.capacity, 0));

/* ----------------------------------------------------------- 注册密钥 */

const enrollOpen = ref(false);
const enrollLoading = ref(false);
const enrollError = ref<string | null>(null);
const enrollCreated = ref<EnrollKeyResult | null>(null);
const enrollKeys = ref<EnrollKeyInfo[]>([]);
const enrollNote = ref('');

async function openEnroll(): Promise<void> {
  enrollOpen.value = true;
  enrollCreated.value = null;
  enrollError.value = null;
  await loadEnrollKeys();
}

async function loadEnrollKeys(): Promise<void> {
  enrollLoading.value = true;
  try {
    enrollKeys.value = asArray(await api.get<EnrollKeyInfo[]>('/admin/nodes/enroll-keys'));
  } catch (err) {
    enrollError.value = friendlyError(err);
  } finally {
    enrollLoading.value = false;
  }
}

async function createEnrollKey(): Promise<void> {
  enrollLoading.value = true;
  try {
    const result = await api.post<EnrollKeyResult>(Routes.adminNodeEnrollKey, { note: enrollNote.value });
    enrollCreated.value = result;
    enrollNote.value = '';
    notifyOk('注册密钥已签发');
    await loadEnrollKeys();
  } catch (err) {
    enrollError.value = reportError(err);
  } finally {
    enrollLoading.value = false;
  }
}

/* --------------------------------------------------------------- 编辑 */

const editing = ref<RelayNode | null>(null);
const saving = ref(false);
const editError = ref<string | null>(null);
const editForm = reactive({
  name: '',
  region: '',
  endpoint: '',
  weight: '100',
  capacityPeers: '500',
  tags: '',
});

function openEdit(node: RelayNode): void {
  editing.value = node;
  editError.value = null;
  editForm.name = node.name;
  editForm.region = node.region;
  editForm.endpoint = node.endpoint;
  editForm.weight = String(node.weight);
  editForm.capacityPeers = String(node.capacityPeers);
  editForm.tags = asStringList(node.tags).join(', ');
}

async function saveEdit(): Promise<void> {
  const node = editing.value;
  if (!node || saving.value) return;
  saving.value = true;
  try {
    await api.patch<RelayNode>(Routes.adminNode(node.id), {
      name: editForm.name.trim(),
      region: editForm.region,
      endpoint: editForm.endpoint.trim(),
      weight: toInt(editForm.weight, node.weight),
      capacityPeers: toInt(editForm.capacityPeers, node.capacityPeers),
      tags: editForm.tags
        .split(/[,，\s]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .slice(0, 8),
    });
    notifyOk('节点已更新');
    editing.value = null;
    await load();
  } catch (err) {
    editError.value = reportError(err);
  } finally {
    saving.value = false;
  }
}

/* ----------------------------------------------------- 禁用 / 删除 */

async function toggleDisabled(node: RelayNode): Promise<void> {
  const next = node.status !== 'disabled';
  const confirmText = next ? `确定禁用节点「${node.name}」？调度器将不再向它分配新房间。` : `确定重新启用「${node.name}」？`;
  if (!confirm(confirmText)) return;
  busyId.value = node.id;
  try {
    await api.post(Routes.adminNode(node.id) + '/disable', { disabled: next });
    notifyOk(next ? '节点已禁用' : '节点已启用');
    await load();
  } catch (err) {
    reportError(err);
  } finally {
    busyId.value = null;
  }
}

async function removeNode(node: RelayNode): Promise<void> {
  if (!confirm(`确定删除节点「${node.name}」？该操作不可撤销，节点需要重新注册才能上线。`)) return;
  busyId.value = node.id;
  try {
    await api.del(Routes.adminNode(node.id));
    notifyOk('节点已删除');
    await load();
  } catch (err) {
    reportError(err);
  } finally {
    busyId.value = null;
  }
}
</script>

<template>
  <div class="stack" style="gap: var(--s-5)">
    <!-- 头部 -->
    <div class="row-between wrap">
      <div>
        <div class="panel-title">中继节点</div>
        <p class="panel-sub">
          子节点即部署在各区域的 EasyTier 公共中继，单端口即可服务所有房间，仅靠网络名白名单决定是否转发。
        </p>
      </div>
      <div class="row">
        <button class="btn" type="button" :disabled="loading" @click="load">
          <span v-if="loading" class="spinner" />
          刷新
        </button>
        <button class="btn btn-primary" type="button" @click="openEnroll">签发注册密钥</button>
      </div>
    </div>

    <!-- 区域汇总 -->
    <section class="card stack">
      <div class="row-between">
        <div class="panel-title" style="font-size: var(--fs-base)">各区域可用性</div>
        <span class="faint" style="font-size: var(--fs-xs)">
          在线 {{ totalOnline }} 节点 · 承载 {{ totalPeers }} peer · 总容量 {{ totalCapacity }}
        </span>
      </div>
      <div v-if="availability.length === 0" class="empty">
        还没有任何区域注册了节点；此时房间会使用主控自带的兜底中继。
      </div>
      <div v-else class="region-chips">
        <div v-for="a in availability" :key="a.region" class="chip">
          <div class="row-between" style="gap: var(--s-3)">
            <strong>{{ regionLabel(a.region) }}</strong>
            <Badge :tone="a.online > 0 ? 'ok' : 'neutral'" dot>{{ a.online }} / {{ a.total }} 在线</Badge>
          </div>
          <div class="faint" style="font-size: var(--fs-xs)">
            peer {{ a.peers }} / 容量 {{ a.capacity }}
          </div>
        </div>
      </div>
    </section>

    <!-- 筛选 -->
    <section class="card filters">
      <div class="field">
        <label class="label" for="f-region">区域</label>
        <select id="f-region" v-model="filters.region" class="select" @change="load">
          <option value="">全部区域</option>
          <option v-for="r in REGIONS" :key="r.id" :value="r.id">{{ r.label }}</option>
        </select>
      </div>
      <div class="field">
        <label class="label" for="f-status">状态</label>
        <select id="f-status" v-model="filters.status" class="select" @change="load">
          <option value="">全部状态</option>
          <option v-for="s in statusOptions" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
      </div>
      <div class="field">
        <label class="label" for="f-search">搜索</label>
        <input
          id="f-search"
          v-model="filters.search"
          class="input"
          type="search"
          placeholder="节点名 / endpoint"
          @keyup.enter="load"
        />
      </div>
      <div class="row" style="align-self: end">
        <button class="btn" type="button" @click="load">应用筛选</button>
        <button class="btn btn-ghost" type="button" @click="resetFilters">重置</button>
      </div>
    </section>

    <!-- 列表 -->
    <section class="card stack">
      <div v-if="loading && nodes.length === 0" class="stack">
        <div v-for="i in 4" :key="i" class="skeleton" style="height: 40px" />
      </div>

      <div v-else-if="error" class="row-between">
        <div>
          <div class="panel-title" style="font-size: var(--fs-base)">加载失败</div>
          <p class="panel-sub">{{ error }}</p>
        </div>
        <button class="btn" type="button" @click="load">重试</button>
      </div>

      <div v-else-if="nodes.length === 0" class="empty">
        没有匹配的节点。你可以「签发注册密钥」，然后在目标机器上执行一键注册命令。
      </div>

      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>名称</th>
              <th>区域</th>
              <th>Endpoint</th>
              <th>状态</th>
              <th class="table-num">peer</th>
              <th class="table-num">房间</th>
              <th class="table-num">实时速率</th>
              <th class="table-num">权重</th>
              <th>最近心跳</th>
              <th>标签</th>
              <th style="text-align: right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="n in nodes" :key="n.id">
              <td>
                <div class="truncate" style="max-width: 200px">{{ n.name }}</div>
                <div class="faint mono" style="font-size: var(--fs-xs)">{{ n.id }}</div>
              </td>
              <td>{{ regionLabel(n.region) }}</td>
              <td class="mono" style="font-size: var(--fs-xs)">{{ n.endpoint }}</td>
              <td><Badge :tone="nodeTone(n.status)" dot>{{ nodeLabel(n.status) }}</Badge></td>
              <td class="table-num">{{ n.peers }} / {{ n.capacityPeers }}</td>
              <td class="table-num">{{ n.rooms }}</td>
              <td class="table-num">{{ formatBitrate(n.rxBps) }} / {{ formatBitrate(n.txBps) }}</td>
              <td class="table-num">{{ n.weight }}</td>
              <td class="muted" style="font-size: var(--fs-xs)">{{ formatRelativeTime(n.lastSeenAt) }}</td>
              <td>
                <div v-if="asStringList(n.tags).length > 0" class="row wrap" style="gap: 4px">
                  <Badge v-for="t in asStringList(n.tags)" :key="t" tone="neutral">{{ t }}</Badge>
                </div>
                <span v-else class="faint">—</span>
              </td>
              <td>
                <div class="row" style="gap: var(--s-2); justify-content: flex-end">
                  <button class="btn btn-sm" type="button" :disabled="busyId === n.id" @click="openEdit(n)">编辑</button>
                  <button class="btn btn-sm" type="button" :disabled="busyId === n.id" @click="toggleDisabled(n)">
                    {{ n.status === 'disabled' ? '启用' : '禁用' }}
                  </button>
                  <button class="btn btn-sm btn-danger" type="button" :disabled="busyId === n.id" @click="removeNode(n)">
                    删除
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 签发注册密钥 -->
    <div v-if="enrollOpen" class="overlay" @click.self="enrollOpen = false">
      <div class="modal card stack">
        <div class="row-between">
          <div>
            <div class="panel-title">签发节点注册密钥</div>
            <p class="panel-sub">密钥一次性有效，节点注册成功即作废。</p>
          </div>
          <button class="btn btn-ghost btn-sm" type="button" @click="enrollOpen = false">关闭</button>
        </div>

        <div class="row" style="gap: var(--s-2)">
          <input v-model="enrollNote" class="input" placeholder="备注（可选，例如：华东-上海-01）" maxlength="80" />
          <button class="btn btn-primary" type="button" :disabled="enrollLoading" @click="createEnrollKey">
            <span v-if="enrollLoading" class="spinner" />
            签发
          </button>
        </div>

        <div v-if="enrollError" class="err-box">{{ enrollError }}</div>

        <div v-if="enrollCreated" class="created-box stack" style="gap: var(--s-3)">
          <div class="row-between">
            <span class="badge badge-ok">新密钥</span>
            <button class="btn btn-sm" type="button" @click="copyText(enrollCreated.enrollKey, '注册密钥')">复制密钥</button>
          </div>
          <div class="mono key-text">{{ enrollCreated.enrollKey }}</div>
          <div class="row-between">
            <span class="faint" style="font-size: var(--fs-xs)">在目标机器上执行（Debian/Ubuntu）</span>
            <button class="btn btn-sm" type="button" @click="copyText(enrollCreated.command, '一键注册命令')">复制命令</button>
          </div>
          <pre class="code-block">{{ enrollCreated.command }}</pre>
        </div>

        <div class="divider" />

        <div class="row-between">
          <span class="panel-sub">已签发密钥（最近 100 条）</span>
          <button class="btn btn-sm btn-ghost" type="button" @click="loadEnrollKeys">刷新</button>
        </div>

        <div v-if="enrollKeys.length === 0" class="empty">还没有签发过注册密钥。</div>
        <div v-else class="table-wrap" style="max-height: 260px; overflow-y: auto">
          <table class="table">
            <thead>
              <tr>
                <th>密钥</th>
                <th>备注</th>
                <th>状态</th>
                <th>签发时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="k in enrollKeys" :key="k.key">
                <td class="mono" style="font-size: var(--fs-xs)">{{ k.key }}</td>
                <td class="muted">{{ k.note ?? '—' }}</td>
                <td>
                  <Badge v-if="k.revoked" tone="danger">已吊销</Badge>
                  <Badge v-else-if="k.usedAt" tone="neutral">已使用 · {{ k.usedBy ?? '' }}</Badge>
                  <Badge v-else tone="ok" dot>未使用</Badge>
                </td>
                <td class="muted" style="font-size: var(--fs-xs)">{{ formatDateTime(k.createdAt) }}</td>
                <td style="text-align: right">
                  <button class="btn btn-sm btn-ghost" type="button" @click="copyText(k.key, '注册密钥')">复制</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 编辑节点 -->
    <div v-if="editing" class="overlay" @click.self="editing = null">
      <div class="modal card stack" style="max-width: 520px">
        <div class="row-between">
          <div>
            <div class="panel-title">编辑节点</div>
            <p class="panel-sub mono">{{ editing.id }}</p>
          </div>
          <button class="btn btn-ghost btn-sm" type="button" @click="editing = null">关闭</button>
        </div>

        <div class="field">
          <label class="label" for="e-name">名称</label>
          <input id="e-name" v-model="editForm.name" class="input" maxlength="40" />
        </div>
        <div class="field">
          <label class="label" for="e-region">区域</label>
          <select id="e-region" v-model="editForm.region" class="select">
            <option v-for="r in REGIONS" :key="r.id" :value="r.id">{{ r.label }}</option>
          </select>
        </div>
        <div class="field">
          <label class="label" for="e-endpoint">Endpoint</label>
          <input id="e-endpoint" v-model="editForm.endpoint" class="input mono" placeholder="relay-sh.example.com:11010" />
          <span class="hint">格式必须为 host:port，且不能与其它节点重复。</span>
        </div>
        <div class="grid" style="grid-template-columns: 1fr 1fr">
          <div class="field">
            <label class="label" for="e-weight">调度权重</label>
            <input id="e-weight" v-model="editForm.weight" class="input" type="number" min="0" />
            <span class="hint">越大越优先；0 表示不再分配新房间。</span>
          </div>
          <div class="field">
            <label class="label" for="e-cap">容量（peer）</label>
            <input id="e-cap" v-model="editForm.capacityPeers" class="input" type="number" min="10" />
          </div>
        </div>
        <div class="field">
          <label class="label" for="e-tags">标签</label>
          <input id="e-tags" v-model="editForm.tags" class="input" placeholder="用逗号或空格分隔，最多 8 个" />
        </div>

        <div v-if="editError" class="err-box">{{ editError }}</div>

        <div class="row" style="justify-content: flex-end">
          <button class="btn" type="button" @click="editing = null">取消</button>
          <button class="btn btn-primary" type="button" :disabled="saving" @click="saveEdit">
            <span v-if="saving" class="spinner" />
            保存
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--s-4);
  align-items: end;
}
.region-chips {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--s-3);
}
.chip {
  padding: var(--s-3);
  border-radius: var(--r-sm);
  background: var(--surface);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.table-wrap {
  overflow-x: auto;
}
.overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  background: color-mix(in srgb, var(--bg-0) 68%, transparent);
  backdrop-filter: blur(3px);
  display: grid;
  place-items: center;
  padding: var(--s-4);
  overflow-y: auto;
}
.modal {
  width: 100%;
  max-width: 680px;
  background: var(--bg-1);
  box-shadow: var(--shadow-lg);
  max-height: calc(100vh - 48px);
  overflow-y: auto;
}
.key-text {
  font-size: var(--fs-lg);
  letter-spacing: 0.06em;
  word-break: break-all;
  color: var(--brand);
}
.created-box {
  padding: var(--s-4);
  border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--brand) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--brand) 22%, transparent);
}
.code-block {
  margin: 0;
  padding: var(--s-3);
  border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--bg-0) 60%, transparent);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: var(--fs-xs);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
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
