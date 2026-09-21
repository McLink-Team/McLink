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
  <div class="console-page">
    <!-- 头部 -->
    <header class="console-head">
      <div class="console-head-text">
        <h1 class="console-head-title">中继节点</h1>
        <p class="console-head-sub">
          子节点即部署在各区域的 EasyTier 公共中继，单端口即可服务所有房间，仅靠网络名白名单决定是否转发。
        </p>
      </div>
      <div class="console-head-actions">
        <button class="btn" type="button" :disabled="loading" @click="load">
          <span v-if="loading" class="spinner" />
          刷新
        </button>
        <button class="btn btn-primary" type="button" @click="openEnroll">签发注册密钥</button>
      </div>
    </header>

    <!-- 区域汇总 -->
    <section class="console-section">
      <div class="console-section-head">
        <div class="console-section-text">
          <h2 class="console-section-title">各区域可用性</h2>
          <p class="console-section-note">
            在线 {{ totalOnline }} 节点 · 承载 {{ totalPeers }} peer · 总容量 {{ totalCapacity }}
          </p>
        </div>
      </div>
      <div v-if="availability.length === 0" class="empty">
        还没有任何区域注册了节点；此时房间会使用主控自带的兜底中继。
      </div>
      <div v-else class="tally">
        <div v-for="a in availability" :key="a.region" class="tally-item">
          <div class="tally-label">{{ regionLabel(a.region) }}</div>
          <div class="tally-value">
            {{ a.online }}<span class="tally-unit">/ {{ a.total }}</span>
          </div>
          <div class="tally-foot">
            <Badge :tone="a.online > 0 ? 'ok' : 'neutral'" dot>{{ a.online > 0 ? '在线' : '全部离线' }}</Badge>
            <span>peer {{ a.peers }} / 容量 {{ a.capacity }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 筛选 -->
    <section class="console-section">
      <div class="console-section-head">
        <div class="console-section-text">
          <h2 class="console-section-title">筛选</h2>
        </div>
      </div>
      <div class="filter-grid">
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
        <div class="filter-actions">
          <button class="btn" type="button" @click="load">应用筛选</button>
          <button class="btn btn-ghost" type="button" @click="resetFilters">重置</button>
        </div>
      </div>
    </section>

    <!-- 列表 -->
    <section class="console-section">
      <div v-if="loading && nodes.length === 0" class="stack-tight">
        <div v-for="i in 4" :key="i" class="skeleton" style="height: 36px" />
      </div>

      <div v-else-if="error" class="console-section-head">
        <div class="console-section-text">
          <div class="console-sub-title">加载失败</div>
          <p class="console-section-note">{{ error }}</p>
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
              <th class="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="n in nodes" :key="n.id">
              <td>
                <div class="wrap-anywhere">{{ n.name }}</div>
                <div class="cell-sub">{{ n.id }}</div>
              </td>
              <td>{{ regionLabel(n.region) }}</td>
              <td class="mono cell-sub">{{ n.endpoint }}</td>
              <td><Badge :tone="nodeTone(n.status)" dot>{{ nodeLabel(n.status) }}</Badge></td>
              <td class="table-num">{{ n.peers }} / {{ n.capacityPeers }}</td>
              <td class="table-num">{{ n.rooms }}</td>
              <td class="table-num">{{ formatBitrate(n.rxBps) }} / {{ formatBitrate(n.txBps) }}</td>
              <td class="table-num">{{ n.weight }}</td>
              <td class="cell-sub">{{ formatRelativeTime(n.lastSeenAt) }}</td>
              <td>
                <div v-if="asStringList(n.tags).length > 0" class="tag-row">
                  <Badge v-for="t in asStringList(n.tags)" :key="t" tone="neutral">{{ t }}</Badge>
                </div>
                <span v-else class="cell-void">无</span>
              </td>
              <td>
                <div class="row-actions">
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
    <div v-if="enrollOpen" class="modal-mask" @click.self="enrollOpen = false">
      <div class="modal-panel">
        <div class="modal-head">
          <div class="console-section-text">
            <h2 class="console-sub-title modal-title">签发节点注册密钥</h2>
            <p class="console-section-note">密钥一次性有效，节点注册成功即作废。</p>
          </div>
          <button class="btn btn-ghost btn-sm" type="button" @click="enrollOpen = false">关闭</button>
        </div>

        <div class="enroll-row">
          <input v-model="enrollNote" class="input" placeholder="备注（可选，例如：华东-上海-01）" maxlength="80" />
          <button class="btn btn-primary" type="button" :disabled="enrollLoading" @click="createEnrollKey">
            <span v-if="enrollLoading" class="spinner" />
            签发
          </button>
        </div>

        <div v-if="enrollError" class="notice notice-danger">{{ enrollError }}</div>

        <div v-if="enrollCreated" class="key-block">
          <div class="key-block-head">
            <Badge tone="ok">新密钥</Badge>
            <button class="btn btn-sm" type="button" @click="copyText(enrollCreated.enrollKey, '注册密钥')">复制密钥</button>
          </div>
          <div class="key-text">{{ enrollCreated.enrollKey }}</div>
          <div class="key-block-head">
            <span class="cell-sub">在目标机器上执行（Debian/Ubuntu）</span>
            <button class="btn btn-sm" type="button" @click="copyText(enrollCreated.command, '一键注册命令')">复制命令</button>
          </div>
          <pre class="code-block">{{ enrollCreated.command }}</pre>
        </div>

        <div class="key-issued">
          <div class="key-issued-head">
            <span class="console-sub-title">已签发密钥（最近 100 条）</span>
            <button class="btn btn-sm btn-ghost" type="button" @click="loadEnrollKeys">刷新</button>
          </div>

          <div v-if="enrollKeys.length === 0" class="empty">还没有签发过注册密钥。</div>
          <div v-else class="table-wrap key-table">
            <table class="table">
              <thead>
                <tr>
                  <th>密钥</th>
                  <th>备注</th>
                  <th>状态</th>
                  <th>签发时间</th>
                  <th class="col-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="k in enrollKeys" :key="k.key">
                  <td class="mono cell-sub key-cell">{{ k.key }}</td>
                  <td v-if="k.note">{{ k.note }}</td>
                  <td v-else class="cell-void">未填写</td>
                  <td>
                    <Badge v-if="k.revoked" tone="danger">已吊销</Badge>
                    <Badge v-else-if="k.usedAt" tone="neutral">已使用 · {{ k.usedBy ?? '' }}</Badge>
                    <Badge v-else tone="ok" dot>未使用</Badge>
                  </td>
                  <td class="cell-sub">{{ formatDateTime(k.createdAt) }}</td>
                  <td>
                    <div class="row-actions">
                      <button class="btn btn-sm btn-ghost" type="button" @click="copyText(k.key, '注册密钥')">复制</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- 编辑节点 -->
    <div v-if="editing" class="modal-mask" @click.self="editing = null">
      <div class="modal-panel edit-panel">
        <div class="modal-head">
          <div class="console-section-text">
            <h2 class="console-sub-title modal-title">编辑节点</h2>
            <p class="console-section-note mono wrap-anywhere">{{ editing.id }}</p>
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
        <div class="pair">
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

        <div v-if="editError" class="notice notice-danger">{{ editError }}</div>

        <div class="modal-foot">
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
.tally-unit {
  font-size: var(--fs-base);
  color: var(--paper-faint);
  margin-left: 5px;
}
.filter-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--s-4);
  align-items: end;
}
.filter-actions {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding-bottom: 1px;
}
.col-actions {
  text-align: right;
}
.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.cell-void {
  font-size: var(--fs-xs);
  color: var(--paper-faint);
}
.row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}
.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-4);
  padding-bottom: var(--s-3);
  border-bottom: 1px solid var(--rule-faint);
}
.modal-title {
  font-family: var(--font-display);
  font-size: var(--fs-lg);
  font-weight: 600;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  padding-top: var(--s-4);
  border-top: 1px solid var(--rule-faint);
}
.enroll-row {
  display: flex;
  align-items: center;
  gap: var(--s-3);
}
.enroll-row .input {
  flex: 1;
  min-width: 0;
}
/* 新密钥块：用一条上发丝线起头，不再套第二层卡片 */
.key-block {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding-top: var(--s-4);
  border-top: 1px solid var(--rule);
}
.key-block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-4);
  flex-wrap: wrap;
}
.key-text {
  font-family: var(--font-mono);
  font-size: var(--fs-lg);
  letter-spacing: 0.05em;
  overflow-wrap: anywhere;
  color: var(--signal);
}
.key-issued {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding-top: var(--s-4);
  border-top: 1px solid var(--rule);
}
.key-issued-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-4);
  flex-wrap: wrap;
}
.key-table {
  max-height: 240px;
  overflow-y: auto;
}
.key-cell {
  max-width: 220px;
}
.edit-panel {
  max-width: 560px;
}
.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--s-4);
}
</style>
