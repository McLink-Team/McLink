<script setup lang="ts">
/**
 * 中继节点管理：筛选、编辑、禁用/启用、删除，以及签发子节点注册密钥。
 * 节点一旦注册就会通过 agent 心跳上报 peer 数与实时速率，这里只做展示与调度元数据维护。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import {
  DEFAULT_GITHUB_PROXY,
  REGIONS,
  Routes,
  formatBitrate,
  formatRelativeTime,
  regionLabel,
  type NodeStatus,
  type RelayNode,
} from '@mclink/shared';
import { api, friendlyError } from '../../lib/api.ts';
import { asArray, asStringList, copyText, formatDateTime, nodeLabel, nodeTone, reportError, toFloat, toInt } from '../../lib/ui.ts';
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
  /** 一条可直接粘贴到目标机器执行的安装命令 */
  command: string;
  /** 命令里用到的部署参数，界面上用来提示端口映射关系 */
  params: {
    region: string;
    name: string;
    host: string | null;
    listenPort: number;
    connectPort: number;
    /** 是否为国内节点（是则命令里带了 GitHub 加速前缀） */
    domestic: boolean;
    githubProxy: string | null;
  };
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
  // 「待上线」= 已注册但还没收到第一次心跳；没有人工审批这一步
  { value: 'pending', label: '待上线' },
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
/**
 * 部署参数：签发密钥时一并收下，直接生成"一条命令"。
 * 两个端口的区别是这块功能的核心，所以界面上要写清楚而不是塞进高级选项：
 *   运行端口 = 子节点本机 easytier-core 监听的端口（防火墙要放行它）
 *   链接端口 = 主控下发给客户端用的端口（NAT 映射后的对外端口）
 */
const enrollForm = reactive({
  region: 'cn-east',
  name: 'relay-sh',
  host: '',
  listenPort: '11010',
  connectPort: '',
  /**
   * 国内节点：装的时候要下 EasyTier 二进制。
   * 取值顺序是「本机已有 → 从主控取 → GitHub」，所以代理只在主控自己没带二进制时
   * 才真正被用到 —— 但那时它就是能不能装上的区别。
   */
  domestic: true,
  githubProxy: DEFAULT_GITHUB_PROXY,
});

async function openEnroll(): Promise<void> {
  enrollOpen.value = true;
  enrollCreated.value = null;
  enrollError.value = null;
  const host = window.location.hostname;
  if (!enrollForm.host) enrollForm.host = host === 'localhost' || host === '127.0.0.1' ? '' : host;
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
    const listen = Math.min(65535, Math.max(1, toInt(enrollForm.listenPort, 11010)));
    // 链接端口留空 = 与运行端口相同（多数部署就是这样）
    const connect = enrollForm.connectPort.trim().length > 0
      ? Math.min(65535, Math.max(1, toInt(enrollForm.connectPort, listen)))
      : listen;
    const result = await api.post<EnrollKeyResult>(Routes.adminNodeEnrollKey, {
      note: enrollNote.value,
      region: enrollForm.region,
      name: enrollForm.name.trim() || undefined,
      host: enrollForm.host.trim() || undefined,
      listenPort: listen,
      connectPort: connect,
      domestic: enrollForm.domestic,
      githubProxy: enrollForm.domestic ? enrollForm.githubProxy.trim() || undefined : undefined,
    });
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
  listenPort: '',
  connectPort: '',
  weight: '100',
  capacityPeers: '500',
  /** 带宽上限，单位 Mbps（按云厂商口径填，如「5 Mbps BGP」填 5；空 = 不限） */
  capacityMbps: '',
  /** 只协助打洞：不转发房间数据（带宽很少的机器用这个） */
  assistOnly: false,
  tags: '',
});

function openEdit(node: RelayNode): void {
  editing.value = node;
  editError.value = null;
  editForm.name = node.name;
  editForm.region = node.region;
  editForm.endpoint = node.endpoint;
  editForm.listenPort = node.listenPort === null ? '' : String(node.listenPort);
  editForm.connectPort = node.connectPort === null ? '' : String(node.connectPort);
  editForm.weight = String(node.weight);
  editForm.capacityPeers = String(node.capacityPeers);
  // 库里存的是 bit/s，界面上按 Mbps 填（云厂商口径）；0 显示成空 = 不限
  editForm.capacityMbps = node.capacityBps > 0 ? String(node.capacityBps / 1_000_000) : '';
  editForm.assistOnly = node.assistOnly === true;
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
      listenPort: toInt(editForm.listenPort, node.listenPort ?? 11010),
      connectPort: toInt(editForm.connectPort, node.connectPort ?? 11010),
      weight: toInt(editForm.weight, node.weight),
      capacityPeers: toInt(editForm.capacityPeers, node.capacityPeers),
      capacityBps: Math.max(0, Math.round(toFloat(editForm.capacityMbps, 0) * 1_000_000)),
      assistOnly: editForm.assistOnly,
      tags: editForm.tags
        .split(/[,，\s]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .slice(0, 8),
    });
    notifyOk('节点已更新；改了运行端口需要在该节点上重装或改 node.env 后重启服务');
    editing.value = null;
    await load();
  } catch (err) {
    editError.value = reportError(err);
  } finally {
    saving.value = false;
  }
}

/* ----------------------------------------------------- 安装 / 更新指令 */

/**
 * 「安装指令」：给这个节点重新生成一条一键安装命令（会新签一把注册密钥）。
 *
 * 为什么必须先确认：注册密钥是一次性的、签发即入库，而且**换机器安装会真的用掉它**
 * （新机器会以新节点身份注册，旧记录留在列表里变成离线）。同机重装则不会换身份 ——
 * 这一点写进确认文案里，否则运维会以为"重装等于掉线"而不敢用。
 */
async function copyInstallCommand(node: RelayNode): Promise<void> {
  const ok = confirm(
    `为「${node.name}」签发一把新的注册密钥并复制安装指令？\n\n` +
      `· 同一台机器上重装：节点身份不变（令牌还在），这把密钥会保持未使用；\n` +
      `· 换一台机器安装：会以**新节点**身份注册，列表里这条旧记录之后会显示离线。`,
  );
  if (!ok) return;
  busyId.value = node.id;
  try {
    const res = await api.post<{ enrollKey: string; command: string }>(`/admin/nodes/${node.id}/reinstall-command`, {});
    await copyText(res.command, `「${node.name}」安装指令`);
  } catch (err) {
    reportError(err);
  } finally {
    busyId.value = null;
  }
}

/**
 * 「更新指令」：不换令牌，只把节点上的 agent / 二进制 / 单元刷到最新并重启。
 * 配置本身不用它 —— agent 每次心跳都会应用主控下发的 configToml。
 */
async function copyUpdateCommand(node: RelayNode): Promise<void> {
  busyId.value = node.id;
  try {
    const res = await api.get<{ command: string }>(`/admin/nodes/${node.id}/update-command`);
    await copyText(res.command, `「${node.name}」更新指令`);
  } catch (err) {
    reportError(err);
  } finally {
    busyId.value = null;
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
          每一行都能复制两条命令：<b>安装指令</b>（新签一把注册密钥，给新机器装或同机重装）
          与<b>更新指令</b>（不换令牌，把节点上的脚本与配置刷到最新）。
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
        还没有任何区域注册了节点；此时建房会直接失败（票据里的中继只会取自区域节点）。
        单机部署可在服务器上执行 <code>sudo node deploy/register-self-node.mjs --region oversea</code>
        把主控这台机器本身注册成节点（详见 docs/deployment.md §2.3.1）。
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
              <th>Endpoint（链接端口）</th>
              <th class="table-num">运行端口</th>
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
              <td>
                <div class="mono wrap-anywhere">{{ n.endpoint }}</div>
                <div v-if="n.listenPort !== null && n.connectPort !== null && n.listenPort !== n.connectPort" class="cell-sub">
                  经 NAT：外部 {{ n.connectPort }} → 本机 {{ n.listenPort }}
                </div>
              </td>
              <td class="table-num mono">{{ n.listenPort ?? '—' }}</td>
              <td>
                <Badge :tone="nodeTone(n.status)" dot>{{ nodeLabel(n.status) }}</Badge>
                <!-- 降级的原因要能看出来：带宽吃紧与人多都会让节点降权 -->
                <div v-if="(n.utilization ?? 0) >= 0.9" class="cell-sub">带宽吃紧</div>
              </td>
              <td class="table-num">{{ n.peers }} / {{ n.capacityPeers }}</td>
              <td class="table-num">{{ n.rooms }}</td>
              <td class="table-num">
                <div>{{ formatBitrate(n.rxBps) }} / {{ formatBitrate(n.txBps) }}</div>
                <!-- 带宽这一行只在配了上限时才有意义：没配就是"不构成约束" -->
                <div v-if="n.capacityBps > 0" class="cell-sub">
                  带宽 {{ Math.round((n.utilization ?? 0) * 100) }}% / {{ formatBitrate(n.capacityBps) }}
                </div>
                <div v-else class="cell-sub">带宽不限</div>
              </td>
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
                  <button class="btn btn-sm" type="button" :disabled="busyId === n.id" @click="copyInstallCommand(n)">
                    安装指令
                  </button>
                  <button class="btn btn-sm" type="button" :disabled="busyId === n.id" @click="copyUpdateCommand(n)">
                    更新指令
                  </button>
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

        <!--
          部署参数：签发的同时就把"装在哪、跑哪个端口"定下来，
          于是拿到的是一条可以直接粘贴的命令，而不是一堆需要手工替换的占位符。
        -->
        <div class="form-grid" style="margin-top: var(--s-3)">
          <div class="field">
            <label class="label" for="enroll-host">节点公网地址</label>
            <input
              id="enroll-host"
              v-model="enrollForm.host"
              class="input mono"
              placeholder="relay-sh.cnnic.link 或 1.2.3.4"
              maxlength="120"
            />
            <span class="hint">客户端最终会连到这个主机名，必须是能解析到该节点的域名或 IP。</span>
          </div>
          <div class="field">
            <label class="label" for="enroll-name">节点名</label>
            <input id="enroll-name" v-model="enrollForm.name" class="input" maxlength="40" placeholder="relay-sh" />
          </div>
          <div class="field">
            <label class="label" for="enroll-region">区域</label>
            <select id="enroll-region" v-model="enrollForm.region" class="select">
              <option v-for="r in REGIONS" :key="r.id" :value="r.id">{{ r.label }}</option>
            </select>
          </div>
          <div class="field">
            <label class="label" for="enroll-listen">运行端口（本机监听）</label>
            <input id="enroll-listen" v-model="enrollForm.listenPort" class="input mono" inputmode="numeric" placeholder="11010" />
            <span class="hint">子节点 easytier-core 实际绑定的端口；防火墙/安全组要放行它（TCP+UDP）。</span>
          </div>
          <div class="field">
            <label class="label" for="enroll-connect">链接端口（对外）</label>
            <input id="enroll-connect" v-model="enrollForm.connectPort" class="input mono" inputmode="numeric" placeholder="留空 = 与运行端口相同" />
            <span class="hint">
              主控下发给客户端的端口。节点在 NAT / 端口映射后面时填映射后的对外端口
              （例如本机 11010、对外 21010）。
            </span>
          </div>
        </div>

        <!-- 国内节点：EasyTier 二进制的下载路径 -->
        <div class="enroll-domestic">
          <label class="switch switch-row">
            <input v-model="enrollForm.domestic" type="checkbox" />
            <span>国内节点（下载 EasyTier 走 GitHub 加速）</span>
          </label>
          <div v-if="enrollForm.domestic" class="field" style="margin-top: var(--s-2)">
            <label class="label" for="enroll-proxy">GitHub 加速前缀</label>
            <input
              id="enroll-proxy"
              v-model="enrollForm.githubProxy"
              class="input mono"
              placeholder="https://ghproxy.net/"
              maxlength="200"
            />
            <span class="hint">
              装节点的脚本取值顺序是：本机已有 → 从主控下载 → GitHub（用这个前缀）。
              主控若自带 Linux 二进制就完全不碰 GitHub；这类公益代理会失效，
              失效了就换一个（<span class="mono">gh-proxy.com</span> /
              <span class="mono">ghfast.top</span> 实测可用）。
            </span>
          </div>
        </div>

        <div v-if="enrollError" class="notice notice-danger">{{ enrollError }}</div>

        <div v-if="enrollCreated" class="key-block">
          <div class="key-block-head">
            <Badge tone="ok">新密钥</Badge>
            <button class="btn btn-sm" type="button" @click="copyText(enrollCreated.enrollKey, '注册密钥')">复制密钥</button>
          </div>
          <div class="key-text">{{ enrollCreated.enrollKey }}</div>
          <div class="key-block-head">
            <span class="cell-sub">
              在目标机器上执行（Debian/Ubuntu，一条命令，无需先拿到本仓库）
            </span>
            <button class="btn btn-sm" type="button" @click="copyText(enrollCreated.command, '一键安装命令')">复制命令</button>
          </div>
          <pre class="code-block wrap-anywhere">{{ enrollCreated.command }}</pre>
          <p class="hint">
            脚本由主控托管（<span class="mono">{{ '/agent/install.sh' }}</span>）：目标机器只要能访问主控，
            就会自动下载安装脚本与 agent、注册节点、拉起 systemd 服务。
            端口不同时，记得在外部把
            <span class="mono">{{ enrollCreated.params.connectPort }}</span>
            映射到本机的 <span class="mono">{{ enrollCreated.params.listenPort }}</span>。
            <template v-if="enrollCreated.params.githubProxy">
              已按国内节点处理：EasyTier 下载会走
              <span class="mono">{{ enrollCreated.params.githubProxy }}</span>。
            </template>
          </p>
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
          <label class="label" for="e-endpoint">Endpoint（客户端连接地址）</label>
          <input id="e-endpoint" v-model="editForm.endpoint" class="input mono" placeholder="relay-sh.example.com:21010" />
          <span class="hint">格式必须为 host:port，且不能与其它节点重复。改链接端口时这里会自动跟随。</span>
        </div>
        <div class="pair">
          <div class="field">
            <label class="label" for="e-listen">运行端口（本机监听）</label>
            <input id="e-listen" v-model="editForm.listenPort" class="input mono" inputmode="numeric" placeholder="11010" />
            <span class="hint">改动会 +1 配置版本；节点下次拉配置时按新端口重启。</span>
          </div>
          <div class="field">
            <label class="label" for="e-connect">链接端口（下发给客户端）</label>
            <input id="e-connect" v-model="editForm.connectPort" class="input mono" inputmode="numeric" placeholder="21010" />
            <span class="hint">保存后 endpoint 的端口同步为它。</span>
          </div>
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
          <div class="field">
            <label class="label" for="e-bw">带宽上限（Mbps）</label>
            <input id="e-bw" v-model="editForm.capacityMbps" class="input" type="number" min="0" step="0.1" placeholder="留空 = 不限" />
            <span class="hint">
              按云厂商口径填（5 Mbps 就填 5）。调度按 <b>3 分钟平均</b>利用率算余量：
              带宽吃紧的节点只是不再优先分配<b>新</b>房间，不会影响正在联机的房间。
            </span>
          </div>
          <div class="field">
            <label class="label" for="e-assist">只协助打洞（不中继）</label>
            <label class="switch-row">
              <input id="e-assist" v-model="editForm.assistOnly" type="checkbox" />
              <span class="hint">
                打开后这台节点**不转发房间流量**，只作为双方都能连上的公共 peer 协调 P2P 打洞
                （生成配置写 <span class="mono">disable_relay_data</span>，EasyTier 会广播 avoid-relay）。
                房间调度把这类节点放在**槽 1（打洞节点）**，真正承载数据的是槽 2 的中继节点 ——
                带宽很少的机器就该这么用。
              </span>
            </label>
            <span class="hint">改这个会 +1 配置版本，节点下一次心跳（≤20 秒）自动应用并重启一次核心。</span>
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
/* 国内节点那一块：与上面的端口表单用发丝线隔开，避免看成同一个字段组 */
.enroll-domestic {
  margin-top: var(--s-3);
  padding-top: var(--s-3);
  border-top: 1px solid var(--rule-faint);
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
