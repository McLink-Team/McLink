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
 * 表单（创建/加入）与逻辑与改造前一致，只有**中继节点与延迟**这一块换了数据来源：
 * 拉节点列表 + tcping 已经挪到应用初始化（登录之后，见 store.ts 的 probeRelayNodes），
 * 这里是纯读缓存的显示层，外加一颗手动「重新测速」。
 */
import { computed, onMounted, ref } from 'vue';
import { regionLabel, type Room } from '@mclink/shared';
import {
  clientState,
  createRoom,
  ensureRelayProbe,
  joinRoom,
  loadRooms,
  openUpdatePage,
  probeRelayNodes,
  reenterRoom,
  relayLatencyHints,
  relayLatencyOf,
  waitForRelayProbe,
  type RelayNodeOption,
} from '../lib/store.ts';
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
  // 主控不再兜底之后，"一个在线节点都没有"就是**真的开不了房**，别再给玩家相反的暗示
  if (nodes === 0) return '暂无在线中继：现在开不了房，请稍后再试或联系客服';
  return `${withNodes.length} 个区域 · ${nodes} 个中继节点在线`;
});

/* ------------------------------------------------------------ 中继节点选择 */

/**
 * 区域与节点是**两层**：区域是默认/筛选，节点才是真正的选择对象。
 * 「自动」= 平台按区域挑（槽 1 打洞 + 槽 2 中继）；「手动」= 玩家自己挑，最多 3 个。
 *
 * ⚠️ 手选节点的**落槽规则**（2026-09-29 修）：这颗按钮让玩家挑的是**中继节点**，
 * 所以手选的节点里"能承载数据"的那台会落**槽 2（中继）**，而"只协助打洞"的节点
 * （不承载流量）落**槽 1（打洞）**，空出来的槽由平台按对应槽位的规则补一台。
 * 规则本体在 `server/src/services/rooms.ts` 的 `assignRelaySlots`（纯函数、有单测）。
 * 以前手选节点被塞在数组最前面 → 客户端按下标判定，玩家挑的中继 100% 被标成「打洞节点」。
 *
 * 节点列表与延迟读的是**应用级缓存**（`clientState.relayNodes` / `relayLatency`）：
 * 拉列表 + tcping 已经在初始化时（登录之后）跑过一遍，这里只负责显示、
 * 以及在缓存为空时补一次（见 onMounted 的 ensureRelayProbe）。
 * 这么放的原因见 store.ts 里 `probeRelayNodes` 的说明：只测一次、建房页与房间页共用，
 * "打开建房页才测"会让手速快的玩家与拉列表失败的人拿到空提示。
 */
const nodeMode = ref<'auto' | 'manual'>('auto');
const manualNodes = ref<string[]>([]);
const nodeList = computed<RelayNodeOption[]>(() => clientState.relayNodes);
/** 探测进行中（**只用于文案**，绝不用来禁用建房；见 store.ts 的 relayProbe） */
const probing = computed(() => clientState.relayProbe.probing);

/** 延迟读数：没测到就是 null，界面显示「—」（**仍然可选**，一次握手超时可能只是抖动） */
const latencyOf = (n: RelayNodeOption): number | null => relayLatencyOf(n);

/**
 * 「重新测速」用的那行状态：探测中 → 说明还在测；测完 → 报最近一次成功探测的时间。
 * 时间只显示到分钟，够玩家判断"这是刚才那次还是昨天下班前那次"。
 */
const probeHint = computed(() => {
  if (probing.value) return '正在测速…（不影响建房：现在就能创建，平台会按负载先挑）';
  const at = clientState.relayProbe.lastProbedAt;
  if (!at) return '还没测到延迟：平台按权重与余量挑节点，不影响建房。';
  const d = new Date(at);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `本机测速完成于 ${hhmm}（只用于「先挑谁」，过时也不影响可用性）。`;
});

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

/** 手动模式的下拉框要不要禁用：节点列表还没拿到（探测中或确实没有可用节点） */
const noNodes = computed(() => nodeList.value.length === 0);

/**
 * 「创建并连接」那颗按钮的文案。
 *
 * 探测进行中时只**换个说法**（让玩家知道马上会用上刚测到的延迟），
 * 绝不 `disabled` —— 见 doCreate 里有界等待的注释：弱网下禁用会让人永远建不了房。
 */
const createLabel = computed(() => {
  if (busy.value) return '创建中…';
  if (probing.value && relayLatencyHints().length === 0) return '测速中…仍可创建';
  return '创建并连接';
});

const allRooms = computed<Room[]>(() => [...clientState.hosted, ...clientState.joined]);

const PANE_TITLE: Record<Exclude<Pane, 'menu'>, string> = {
  create: '创建房间',
  join: '加入房间',
};

onMounted(() => {
  /**
   * 缓存优先：初始化时（登录之后）已经探过一次，这里通常什么都不做。
   * 只有在**缓存为空**时才补一次（初始化那次失败、或客户端启动时还没登录），
   * 而且照旧后台跑、不阻塞这一屏 —— 建房按钮从头到尾都不看它（见 doCreate）。
   */
  ensureRelayProbe();
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
    /**
     * 进房请求里也带 `latencyHints` —— 主控用它决定**这名成员被分到哪台中继**
     * （延迟优先，相差 10ms 以内取空余带宽最大的那台）。
     *
     * 于是这里和建房走同一条有界等待（最多 `RELAY_PROBE_WAIT_MS`，见 store.ts 的
     * `waitForRelayProbe`）：没有在跑的探测 / 已经有提示 → 立刻返回；
     * 超时或探测失败 → 照常进房（空提示照样能进，只是主控按负载挑）。
     * 换句话说：**测速永远挡不住进房**，但"探测还在跑就静默拿空提示发出去"不再是默认路径。
     */
    if (relayLatencyHints().length === 0) await waitForRelayProbe();
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
    /**
     * ⚠️ 「手速快过测速」的修法：建房按钮**不禁用**（弱网/节点全不可达时禁用会让人永远建不了房），
     * 所以玩家完全可能在 tcping 还在跑的时候就点提交 —— 那一刻延迟提示是空数组，
     * 主控那侧的延迟键失效，直接退化成"权重 × 余量"排序。
     *
     * 这里先**有界等待**那次探测（最多 `RELAY_PROBE_WAIT_MS`，见 store.ts 的 waitForRelayProbe）：
     *   · 没有在跑的探测 / 已经有提示 → 立刻返回，不多花一毫秒；
     *   · 超时或探测失败 → 照常发请求（空提示也能建房，只是主控按负载排）。
     * 换句话说：探测**永远不会**挡住建房，但"探测还在跑就静默拿空提示发出去"不再是默认路径。
     */
    if (relayLatencyHints().length === 0) await waitForRelayProbe();
    await createRoom({
      name: form.value.name.trim(),
      zone: form.value.zone,
      // 手动模式下把手选节点带上；自动模式传空数组，由平台按区域调度
      nodeIds: nodeMode.value === 'manual' ? manualNodes.value : [],
      /**
       * 延迟提示两种模式都带：自动模式下它决定"选谁"，
       * 手动模式下它只决定"平台补的那台先落在哪台"。
       * 手选节点的**落槽**由主控按能力决定（能承载数据的当中继，只协助打洞的当打洞），
       * 见 `server/src/services/rooms.ts` 的 `assignRelaySlots`。
       * 值来自应用级缓存（见 store.ts 的 relayLatencyHints）。
       */
      latencyHints: relayLatencyHints(),
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
              :disabled="noNodes"
              @click="nodeMode = 'manual'"
            >
              手动选择
            </button>
            <button
              v-if="nodeMode === 'manual'"
              class="btn btn-sm btn-ghost"
              type="button"
              :disabled="probing"
              @click="probeRelayNodes()"
            >
              {{ probing ? '测速中…' : '重新测速' }}
            </button>
          </div>

          <template v-if="nodeMode === 'manual'">
            <div v-if="noNodes" class="hint">当前没有可用节点，只能用自动选择。</div>
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
                  <span class="roster-sub">
                    {{ regionLabel(n.region) }} · 承载 {{ n.peers }}/{{ n.capacity }}
                    <!-- 只协助打洞的节点不承载流量：挑它只会落"打洞节点"，中继由平台另补一台 -->
                    <template v-if="n.assistOnly"> · 只协助打洞（不承载流量）</template>
                  </span>
                </span>
                <!-- 延迟只用来展示与排序：没测到显示 —，但仍然可选（一次握手超时可能只是抖动） -->
                <span class="badge" :class="latencyOf(n) === null ? 'badge-neutral' : 'badge-ok'">
                  {{ latencyOf(n) === null ? '—' : `${latencyOf(n)} ms` }}
                </span>
              </label>
            </div>
            <div class="hint">
              最多选 3 个。你选的节点会作为「中继节点」（真正转发房间流量）；
              标着「只协助打洞」的节点不承载流量，只会落「打洞节点」，
              中继由平台另补一台。平台补的那台也按同一套规则挑，所以你选的节点掉线房间也不会断。
            </div>
          </template>
          <div v-else class="hint">
            平台按你本机刚测到的延迟优先挑：延迟相差 5ms 以内的算同一档，档内挑带宽最空的；没测到的节点排在最后。
            测速结果只用于「先挑谁」，过时了也不影响节点可用性。
          </div>
          <!-- 探测状态（测速中 / 最近一次成功测速的时间）：只报事实，不做任何阻断 -->
          <div class="hint faint">{{ probeHint }}</div>
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
        <!--
          文案会说"测速中"，但**按钮始终可点**（只在请求飞行中才 disabled）：
          弱网或节点全不可达时，探测可能一直失败 —— 禁用按钮等于让玩家永远建不了房。
          点下去之后 doCreate 里有界等一小会儿再取延迟提示（见那里的注释）。
        -->
        <button class="btn btn-primary" type="button" :disabled="busy" @click="doCreate">
          {{ createLabel }}
        </button>
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
