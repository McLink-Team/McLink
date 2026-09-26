<script setup lang="ts">
/**
 * 「联机」首页 —— 开房前的那一屏。
 *
 * 形态取自参照稿的首页：一张大牌 + 右下角一颗「创建 / 加入」胶囊。
 * 但那张大牌里**不是插画**（我们没有任何美术素材，也不许假装有），
 * 而是这条链路本身：你 ── 主控 ── 房间。三个站点都写实情，
 * 第三个站点故意是空的 —— 那正是这一屏要让玩家去补上的东西。
 *
 * 动作胶囊被 Teleport 到外壳底部的 `#deck-actions`（右下角），
 * 于是"创建/加入"永远在同一个位置，跟参照稿一致。
 *
 * 表单（创建/加入）与逻辑与改造前完全一致，只是换到新的组件层里渲染。
 */
import { computed, onMounted, ref } from 'vue';
import { Routes, regionLabel, type RelayLatencyHint, type Room } from '@mclink/shared';
import { api } from '../lib/api.ts';
import { probeKey, type ProbeTarget } from '../lib/bridge.ts';
import { clientState, createRoom, joinRoom, loadRooms, openUpdatePage, reenterRoom } from '../lib/store.ts';
import { friendlyError } from '../lib/api.ts';
import RoomShortcuts from './RoomShortcuts.vue';

const emit = defineEmits<{ 'open-settings': [] }>();

type Pane = 'menu' | 'create' | 'join';

const pane = ref<Pane>('menu');
const code = ref('');
const joinPassword = ref('');
const busy = ref(false);
const error = ref('');
const loadingRooms = ref(false);

const form = ref({
  name: `房间 ${clientState.user?.displayName ?? ''}`.trim(),
  zone: 'auto',
  access: 'open' as 'open' | 'password' | 'approval',
  password: '',
  visibility: 'public' as 'public' | 'hidden',
  maxPlayers: 8,
});

const regions = computed(() => clientState.regions);

/* ------------------------------------------------------------ 链路牌上的实情 */

/** 主控那一站显示主机名而不是整条 URL：牌面窄，全 URL 会把三个站点挤歪 */
const masterHost = computed(() => {
  try {
    return new URL(clientState.masterUrl).host;
  } catch {
    return clientState.masterUrl;
  }
});

/**
 * 可用中继：有在线节点的区域数 + 节点总数（都来自 /regions 的真数据）。
 *
 * **必须排掉 `auto` 这个伪区域**：它的 onlineNodes 本身就是"所有真实区域的合计"
 * （见 server/src/api/public.ts 的 Routes.regions），一起加进来会正好翻倍 ——
 * 实测线上 7 个在线中继被显示成 14 个（用户一眼看出来不对）。
 */
const relaySummary = computed(() => {
  const real = clientState.regions.filter((r) => r.id !== 'auto');
  const withNodes = real.filter((r) => r.onlineNodes > 0);
  const nodes = real.reduce((sum, r) => sum + r.onlineNodes, 0);
  if (nodes === 0) return '暂无在线中继，主控自带中继兜底';
  return `${withNodes.length} 个区域 · ${nodes} 个中继节点在线`;
});

/* ------------------------------------------------------------ 中继节点选择 */

/**
 * 区域与节点是**两层**：区域是默认/筛选，节点才是真正的选择对象。
 * 「自动」= 平台按区域挑（现状不变）；「手动」= 玩家自己挑，最多 3 个，
 * 并且平台**始终再补一个兜底** —— 玩家选的节点掉线时房间不会断。
 */
const nodeMode = ref<'auto' | 'manual'>('auto');
const manualNodes = ref<string[]>([]);
interface NodeOption {
  id: string;
  name: string;
  region: string;
  host: string;
  /** 链接端口：**客户端真正要连的端口**，由主控按票据同一套规则下发 */
  port?: number;
  peers: number;
  capacity: number;
}
const nodeList = ref<NodeOption[]>([]);
/** `host:port` → 最小时延（ms）；null 表示这次 TCP 握手没成功（只用于展示，不代表节点不可用） */
const latency = ref<Record<string, number | null>>({});
const probing = ref(false);

/**
 * 探测目标 = 节点的 `host:port`。
 *
 * 端口缺了就用 `/meta` 的平台端口兜底（只有没升级的老主控会缺这一项），
 * 还是拿不到就返回 null —— 与其猜一个端口连出个假数字，不如让界面显示「—」。
 */
function probeTargetOf(n: NodeOption): ProbeTarget | null {
  const port = n.port && n.port > 0 ? n.port : clientState.platform.relayPort;
  return port > 0 ? { host: n.host, port } : null;
}

const latencyOf = (n: NodeOption): number | null => {
  const target = probeTargetOf(n);
  return target === null ? null : (latency.value[probeKey(target)] ?? null);
};

/**
 * 把本机这次测到的延迟整理成建房请求的 `latencyHints`。
 *
 * 主控拿它**只在已经合格的候选之间排序**（自动模式选谁、手动模式先挑哪台当兜底）：
 * 它绝不放松任何硬条件（未接入/停用/权重 0/没余量/区域不符的节点，提示也拉不进来），
 * 也不影响手动勾选的优先级。测不到（null）的节点不报 —— "没测到"不是"延迟 0"。
 *
 * 过时这件事是明摆着的：值就是点「创建并连接」这一刻的握手延迟，之后网络会变。
 * 这里**不做**刷新/校验，主控也不判过期 —— 它只是个排序偏好，
 * 真失效的节点由主控的状态与容量兜住，用一组稍旧的相对大小排序仍然比纯按负载更贴近体感。
 */
function latencyHints(): RelayLatencyHint[] {
  const out: RelayLatencyHint[] = [];
  for (const n of nodeList.value) {
    const ms = latencyOf(n);
    if (ms !== null && Number.isFinite(ms)) out.push({ nodeId: n.id, ms });
  }
  return out;
}

/** 按延迟排序；没测到的排在最后（但**仍然可选**） */
const sortedNodes = computed(() =>
  [...nodeList.value].sort((a, b) => {
    const la = latencyOf(a);
    const lb = latencyOf(b);
    if (la === null && lb === null) return a.name.localeCompare(b.name);
    if (la === null) return 1;
    if (lb === null) return -1;
    return la - lb;
  }),
);

async function probeNodes(): Promise<void> {
  if (nodeList.value.length === 0) return;
  probing.value = true;
  try {
    /**
     * 测的是**中继链接端口的 TCP 握手**（tcping，不是 ICMP）：DNS + 路由 + 端口放行 + 握手
     * 全算在内，与真正建房走的是同一条路径；每个节点连打 3 次取最快的一次，
     * 免得偶发丢包让整行显示「—」（见 electron/tcping.cjs）。
     */
    const targets = nodeList.value.map(probeTargetOf).filter((t): t is ProbeTarget => t !== null);
    latency.value = targets.length > 0 ? await window.mclink.tcping(targets) : {};
  } catch {
    /* 探测失败就整体留空，界面显示 — */
  } finally {
    probing.value = false;
  }
}

async function loadNodes(): Promise<void> {
  try {
    const res = await api.get<{ nodes: NodeOption[] }>(Routes.clientNodes);
    nodeList.value = Array.isArray(res.nodes) ? res.nodes : [];
    await probeNodes();
  } catch {
    // 取不到节点列表时静默退化为自动选择 —— 不该因为列不出节点就挡住建房
    nodeList.value = [];
  }
}

const allRooms = computed<Room[]>(() => [...clientState.hosted, ...clientState.joined]);

const PANE_TITLE: Record<Exclude<Pane, 'menu'>, string> = {
  create: '创建房间',
  join: '加入房间',
};

onMounted(() => {
  void loadNodes();
  void refreshRooms();
});

async function refreshRooms(): Promise<void> {
  loadingRooms.value = true;
  try {
    await loadRooms();
  } catch {
    /* 列表拉不到不影响建房/加入，静默即可 */
  } finally {
    loadingRooms.value = false;
  }
}

function open(next: Pane): void {
  error.value = '';
  pane.value = next;
}

async function doJoin(): Promise<void> {
  error.value = '';
  const value = code.value.trim().toUpperCase();
  if (value.length === 0) {
    error.value = '请填写房间加入码';
    return;
  }
  busy.value = true;
  try {
    await joinRoom(value, joinPassword.value || undefined);
    code.value = '';
    joinPassword.value = '';
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}

async function doCreate(): Promise<void> {
  error.value = '';
  if (!form.value.name.trim()) {
    error.value = '请给房间起个名字';
    return;
  }
  busy.value = true;
  try {
    await createRoom({
      name: form.value.name.trim(),
      zone: form.value.zone,
      // 手动模式下把手选节点带上；自动模式传空数组，由平台按区域调度
      nodeIds: nodeMode.value === 'manual' ? manualNodes.value : [],
      /**
       * 延迟提示两种模式都带：自动模式下它决定"选谁"，
       * 手动模式下它只决定"平台补的那个兜底先落在哪台"（手选节点永远优先）。
       */
      latencyHints: latencyHints(),
      access: form.value.access,
      password: form.value.access === 'password' ? form.value.password : undefined,
      visibility: form.value.visibility,
      maxPlayers: form.value.maxPlayers,
    });
    pane.value = 'menu';
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}

async function resume(room: Room): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await reenterRoom(room.id);
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="home">
    <!-- ------------------------------------------------------------- 主页 -->
    <template v-if="pane === 'menu'">
      <div v-if="error" class="alert alert-danger">{{ error }}</div>

      <!-- 链路牌：一屏里最重的一块，也是这一屏的论点 -->
      <section class="plate">
        <div class="plate-head">
          <h2 class="plate-title">还没开房</h2>
          <p class="plate-lede">
            点右下角「创建」开一个房间，把地址发给朋友，他们在游戏里「直接连接」粘上就能进来。
          </p>
        </div>

        <!-- 你 ── 主控 ── 房间：三个站点，第三个故意是空的 -->
        <ol class="link">
          <li class="link-stop is-here">
            <span class="link-dot" />
            <span class="link-name">你</span>
            <span class="link-value">{{ clientState.deviceName }}</span>
          </li>
          <li class="link-wire" aria-hidden="true" />
          <li class="link-stop">
            <span class="link-dot" />
            <span class="link-name">主控</span>
            <span class="link-value mono">{{ masterHost }}</span>
          </li>
          <li class="link-wire is-empty" aria-hidden="true" />
          <li class="link-stop is-empty">
            <span class="link-dot" />
            <span class="link-name">房间</span>
            <span class="link-value">等你创建</span>
          </li>
        </ol>

        <!-- 三步：横排三段。这是一段**有顺序**的流程（先开房、再发地址、朋友粘贴），
             所以编号在这里是有信息的，不是装饰。三种动作彼此独立，各自占一列。 -->
        <ol class="steps">
          <li class="step">
            <span class="step-name">先开房</span>
            <span class="step-body">房主在游戏里「对局域网开放」，再回这里点「创建」。</span>
          </li>
          <li class="step">
            <span class="step-name">发地址</span>
            <span class="step-body">房间页上的联机地址整块可点即复制，发给朋友就行。</span>
          </li>
          <li class="step">
            <span class="step-name">朋友连</span>
            <span class="step-body">他们在游戏里「多人游戏 → 直接连接」粘贴即可进来。</span>
          </li>
        </ol>

        <div class="plate-foot">
          <span class="plate-meta">{{ relaySummary }}</span>
          <span class="plate-sign">McLink · 支持《我的世界》等各类局域网联机游戏</span>
        </div>
      </section>

      <!--
        新版本提示：安静地放在牌下方，不抢「创建」。
        只说两件事 —— 有新版本、从哪拿 —— 不给玩家第三个决定。
      -->
      <div v-if="clientState.update" class="update-note">
        <span class="grow">
          有新版本 <span class="mono">v{{ clientState.update.latest }}</span>
          （当前 <span class="mono">v{{ clientState.localVersion }}</span>）
        </span>
        <button class="btn btn-sm" type="button" @click="openUpdatePage()">下载新版</button>
      </div>
    </template>

    <!-- --------------------------------------------------------- 创建房间 -->
    <template v-else-if="pane === 'create'">
      <div class="pane-head">
        <button class="btn btn-ghost btn-sm" type="button" @click="open('menu')">← 返回</button>
        <span class="pane-title">{{ PANE_TITLE.create }}</span>
      </div>

      <div v-if="error" class="alert alert-danger">{{ error }}</div>

      <div class="card pane stack">
        <div class="field">
          <label class="label">房间名称</label>
          <input v-model="form.name" class="input" maxlength="32" />
        </div>
        <div class="field">
          <label class="label">联机区域</label>
          <select v-model="form.zone" class="select">
            <option v-for="r in regions" :key="r.id" :value="r.id">
              {{ r.label }}{{ r.onlineNodes > 0 ? ` · ${r.onlineNodes} 个节点` : '' }}
            </option>
          </select>
          <div class="hint">不确定就留「自动选择」：平台按你本机刚测到的延迟优先挑中继。</div>
        </div>

        <!-- 中继节点：区域只是筛选，这里才是真正选谁的问题 -->
        <div class="field">
          <label class="label">中继节点</label>
          <div class="row" style="gap: var(--s-2)">
            <button
              class="btn btn-sm"
              :class="nodeMode === 'auto' ? 'btn-primary' : 'btn-ghost'"
              type="button"
              @click="nodeMode = 'auto'"
            >
              自动选择
            </button>
            <button
              class="btn btn-sm"
              :class="nodeMode === 'manual' ? 'btn-primary' : 'btn-ghost'"
              type="button"
              :disabled="nodeList.length === 0"
              @click="nodeMode = 'manual'"
            >
              手动选择
            </button>
            <button
              v-if="nodeMode === 'manual'"
              class="btn btn-sm btn-ghost"
              type="button"
              :disabled="probing"
              @click="probeNodes()"
            >
              {{ probing ? '测速中…' : '重新测速' }}
            </button>
          </div>

          <template v-if="nodeMode === 'manual'">
            <div v-if="nodeList.length === 0" class="hint">当前没有可用节点，只能用自动选择。</div>
            <div v-else class="roster">
              <label v-for="n in sortedNodes" :key="n.id" class="roster-row node-pick">
                <input
                  v-model="manualNodes"
                  type="checkbox"
                  :value="n.id"
                  :disabled="manualNodes.length >= 3 && !manualNodes.includes(n.id)"
                />
                <span class="grow roster-main">
                  <span class="roster-name">{{ n.name }}</span>
                  <span class="roster-sub">{{ regionLabel(n.region) }} · 承载 {{ n.peers }}/{{ n.capacity }}</span>
                </span>
                <!-- 延迟只用来展示与排序：没测到显示 —，但仍然可选（一次握手超时可能只是抖动） -->
                <span class="badge" :class="latencyOf(n) === null ? 'badge-neutral' : 'badge-ok'">
                  {{ latencyOf(n) === null ? '—' : `${latencyOf(n)} ms` }}
                </span>
              </label>
            </div>
            <div class="hint">
              最多选 3 个；平台始终再补一个兜底节点（按同一套延迟优先规则挑），所以你选的节点掉线房间也不会断。
            </div>
          </template>
          <div v-else class="hint">
            平台按你本机刚测到的延迟优先挑：延迟接近的才比负载与余量，没测到的节点排在最后，并自动留冗余。
            测速结果只用于「先挑谁」，过时了也不影响节点可用性。
          </div>
        </div>

        <div class="pair">
          <div class="field">
            <label class="label">加入方式</label>
            <select v-model="form.access" class="select">
              <option value="open">任何人凭加入码</option>
              <option value="password">需要房间密码</option>
              <option value="approval">需要我审批</option>
            </select>
          </div>
          <div class="field">
            <label class="label">最大人数</label>
            <input v-model.number="form.maxPlayers" class="input" type="number" min="2" max="64" />
          </div>
        </div>
        <div v-if="form.access === 'password'" class="field">
          <label class="label">房间密码</label>
          <input v-model="form.password" class="input" />
          <div class="hint">要把密码和加入码一起告诉朋友。</div>
        </div>
        <div class="field">
          <label class="label">可见性</label>
          <select v-model="form.visibility" class="select">
            <option value="public">公开在大厅（别人能在大厅看到）</option>
            <option value="hidden">仅凭加入码</option>
          </select>
        </div>
      </div>

      <p class="hint">创建后会立刻为你建立虚拟网络，并把联机地址显示在这一屏上。</p>
    </template>

    <!-- --------------------------------------------------------- 加入房间 -->
    <template v-else>
      <div class="pane-head">
        <button class="btn btn-ghost btn-sm" type="button" @click="open('menu')">← 返回</button>
        <span class="pane-title">{{ PANE_TITLE.join }}</span>
      </div>

      <div v-if="error" class="alert alert-danger">{{ error }}</div>

      <div class="card pane stack">
        <div class="field">
          <label class="label">房间加入码</label>
          <input
            v-model="code"
            class="input mono code-input"
            maxlength="6"
            placeholder="例如 K7QM2P"
            @keyup.enter="doJoin"
          />
        </div>
        <div class="field">
          <label class="label">房间密码（房主设了才要填）</label>
          <input v-model="joinPassword" class="input" type="password" @keyup.enter="doJoin" />
        </div>
      </div>

      <div class="pane-split">
        <div class="section-head">
          <span class="title">我的房间</span>
          <span class="count mono">{{ allRooms.length }}</span>
          <span class="grow" />
          <button class="btn btn-sm btn-ghost" type="button" :disabled="loadingRooms" @click="refreshRooms()">
            刷新
          </button>
        </div>

        <div v-if="allRooms.length > 0" class="roster">
          <div v-for="room in allRooms" :key="room.id" class="roster-row">
            <span class="grow roster-main">
              <span class="roster-name">{{ room.name }}</span>
              <span class="roster-sub mono">
                {{ room.code }} · {{ regionLabel(room.zone) }} · {{ room.onlineMembers }}/{{
                  room.policy.maxPlayers
                }}
              </span>
            </span>
            <span class="badge" :class="room.hostUserId === clientState.user?.id ? 'badge-brand' : 'badge-neutral'">
              {{ room.hostUserId === clientState.user?.id ? '房主' : '成员' }}
            </span>
            <button class="btn btn-sm" type="button" :disabled="busy" @click="resume(room)">进入</button>
          </div>
        </div>
        <p v-else class="hint">还没有房间。自己开一个，或者用朋友给的加入码进来。</p>
      </div>

      <RoomShortcuts />
    </template>

    <!--
      主动作胶囊：Teleport 到外壳底部右下角（`defer` 让它在目标渲染后再插入 —— 
      子组件先于父组件的模板挂载，不加 defer 会找不到目标）。
      表单打开时换成一枚「返回」+ 提交动作，位置不变。
    -->
    <Teleport defer to="#deck-actions">
      <template v-if="pane === 'menu'">
        <button class="btn btn-ghost" type="button" @click="open('join')">加入</button>
        <button class="btn btn-primary" type="button" @click="open('create')">创建</button>
      </template>
      <template v-else-if="pane === 'create'">
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="open('menu')">取消</button>
        <button class="btn btn-primary" type="button" :disabled="busy" @click="doCreate">创建并连接</button>
      </template>
      <template v-else>
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="open('menu')">取消</button>
        <button class="btn btn-primary" type="button" :disabled="busy" @click="doJoin">加入房间</button>
      </template>
    </Teleport>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  /* 撑满可视高度：这一屏是"开房前"的全部内容，牌要占住版面而不是缩在顶部 */
  flex: 1;
  min-height: 0;
}

.code-input {
  text-transform: uppercase;
  letter-spacing: 0.22em;
}
/* 表单里的两列：窄窗下自动并成一列 */
.pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: var(--s-3);
}
.pane-split {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding-top: var(--s-2);
  border-top: 1px solid var(--rule);
}
.pane-head {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.pane-title {
  font-family: var(--font-display);
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--ink);
}

/* --------------------------------------------------------------- 链路牌 */
.plate {
  display: flex;
  flex-direction: column;
  gap: var(--s-5);
  padding: var(--s-5) var(--s-5) var(--s-4);
  background: var(--surface);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-card);
  /* 牌的体量感来自它自己占的高度：参照稿里那张封面就是整屏的主视觉 */
  flex: 1;
  min-height: 260px;
}
.plate-head {
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
  max-width: 46ch;
}
.plate-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--fs-2xl);
  font-weight: 650;
  letter-spacing: var(--track-tight);
  color: var(--ink);
}
.plate-lede {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-sm);
  line-height: var(--lh-snug);
}

/* 三个站点：用一条真实的连接线串起来，第三个是空的 —— 空本身就是信息 */
.link {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  list-style: none;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.link-stop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-width: 0;
  text-align: center;
}
.link-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent);
}
.link-name {
  font-size: var(--fs-xs);
  color: var(--ink-3);
}
.link-value {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--ink);
  max-width: 16ch;
  overflow-wrap: anywhere;
}
/* 空的那一站：虚线点 + 弱文字，一眼看出"还差这一步" */
.link-stop.is-empty .link-dot {
  background: transparent;
  border: 1.5px dashed var(--ink-faint);
}
.link-stop.is-empty .link-value {
  color: var(--ink-3);
  font-weight: 500;
}
.link-wire {
  flex: 1;
  height: 1.5px;
  min-width: 24px;
  background: var(--line);
}
.link-wire.is-empty {
  /* 只有"还没接上"的那一段用虚线：实线=已经在的链路，虚线=待建立的 */
  background: repeating-linear-gradient(
    to right,
    var(--ink-faint) 0 4px,
    transparent 4px 8px
  );
}

.plate-foot {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s-3);
  flex-wrap: wrap;
  padding-top: var(--s-3);
  border-top: 1px solid var(--line-soft);
  /* 压到牌的底边：像参照稿那张封面上的落款 */
  margin-top: auto;
}
.plate-meta {
  color: var(--ink-2);
  font-size: var(--fs-xs);
}
.plate-sign {
  color: var(--ink-3);
  font-size: var(--fs-xs);
}

/* 三步：横排三段，中间用发丝线分开（不是三张卡 —— 卡里套卡是这行的通病） */
.steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--s-5);
  list-style: none;
  margin: 0;
  padding: 0;
}
.step {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-left: var(--s-3);
  border-left: 1px solid var(--line);
}
.step-name {
  color: var(--ink);
  font-size: var(--fs-sm);
  font-weight: 650;
}
.step-body {
  color: var(--ink-3);
  font-size: var(--fs-xs);
  line-height: var(--lh-snug);
  text-wrap: pretty;
}
</style>
