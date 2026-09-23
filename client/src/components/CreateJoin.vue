<script setup lang="ts">
/**
 * 主界面（未进房）。
 *
 * 结构：一屏居中 —— 印记、品牌字、一行副标题，然后是一列全宽按钮。
 * 点「创建房间 / 加入房间 / 公共广场」后，同一个舞台换成对应表单，
 * 而不是把三张表单一起堆在主页上：460px 宽的窗口里那样会立刻变成
 * 一条要滚动的长页面，最重要的那个按钮反而被推到折叠线以下。
 *
 * 「我的房间」与收藏/最近进入都在「加入房间」里 —— 它们都是"进某个房间"，
 * 和填加入码是同一件事的两种做法。
 */
import { computed, onMounted, ref } from 'vue';
import { REGIONS, Routes, regionLabel, type Room } from '@mclink/shared';
import { api } from '../lib/api.ts';
import { clientState, createRoom, joinRoom, loadRooms, openUpdatePage, reenterRoom } from '../lib/store.ts';
import { friendlyError } from '../lib/api.ts';
import BrandLockup from './BrandLockup.vue';
import PublicPlaza from './PublicPlaza.vue';
import RoomShortcuts from './RoomShortcuts.vue';

defineProps<{ version: string }>();
const emit = defineEmits<{ 'open-settings': [] }>();

type Pane = 'menu' | 'create' | 'join' | 'plaza';

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

/* ------------------------------------------------------------ 中继节点选择 */

/**
 * 区域与节点是**两层**：区域是默认/筛选，节点才是真正的选择对象。
 * 「自动」= 平台按区域挑（现状不变）；「手动」= 玩家自己挑，最多 3 个，
 * 并且平台**始终再补一个兜底** —— 玩家选的节点掉线时房间不会断。
 */
const nodeMode = ref<'auto' | 'manual'>('auto');
const manualNodes = ref<string[]>([]);
interface NodeOption { id: string; name: string; region: string; host: string; peers: number; capacity: number }
const nodeList = ref<NodeOption[]>([]);
/** host → 最小时延（ms）；null 表示 ping 不通（不代表节点不可用） */
const latency = ref<Record<string, number | null>>({});
const probing = ref(false);

const latencyOf = (n: NodeOption): number | null => latency.value[n.host] ?? null;
/** 按延迟排序；ping 不通的排在最后（但**仍然可选**） */
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
    latency.value = await window.mclink.ping(nodeList.value.map((n) => n.host));
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

onMounted(() => {
  void loadNodes();
});
const allRooms = computed<Room[]>(() => [...clientState.hosted, ...clientState.joined]);

const PANE_TITLE: Record<Exclude<Pane, 'menu'>, string> = {
  create: '创建房间',
  join: '加入房间',
  plaza: '公共广场',
};

onMounted(() => {
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
    <div class="home-stage">
      <div class="home-main is-wide">
        <BrandLockup v-if="pane === 'menu'">《我的世界》局域网联机工具</BrandLockup>

        <!-- ----------------------------------------------------------- 主页 -->
        <template v-if="pane === 'menu'">
          <div v-if="error" class="alert alert-danger">{{ error }}</div>

          <div class="stack-btns">
            <button class="btn btn-primary" type="button" @click="open('create')">创建房间</button>
            <button class="btn btn-frame" type="button" @click="open('join')">加入房间</button>
            <button class="btn btn-ghost" type="button" @click="open('plaza')">公共广场</button>
            <button class="btn btn-ghost" type="button" @click="emit('open-settings')">设置</button>
          </div>

          <ol class="home-note">
            <li>房主先在游戏里「对局域网开放」，再回这里创建房间。</li>
            <li>把房间页上的联机地址发出去。</li>
            <li>朋友在游戏里「多人游戏 → 直接连接」粘贴即可。</li>
          </ol>

          <!--
            新版本提示：安静地放在动作下方，不抢「创建房间」。
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

        <!-- ------------------------------------------------------- 创建房间 -->
        <template v-else-if="pane === 'create'">
          <div class="pane-head">
            <button class="btn btn-ghost btn-sm" type="button" @click="open('menu')">← 返回</button>
            <span class="pane-title">{{ PANE_TITLE.create }}</span>
          </div>

          <div v-if="error" class="alert alert-danger">{{ error }}</div>

          <div class="stack">
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
              <div class="hint">不确定就留「自动选择」，会挑一个延迟低的中继。</div>
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
                    <!-- ping 只用来展示与排序：超时显示 —，但仍然可选（有些节点丢 ICMP 但中继正常） -->
                    <span class="badge" :class="latencyOf(n) === null ? 'badge-neutral' : 'badge-ok'">
                      {{ latencyOf(n) === null ? '—' : `${latencyOf(n)} ms` }}
                    </span>
                  </label>
                </div>
                <div class="hint">
                  最多选 3 个；平台**始终再补一个兜底节点**，所以你选的节点掉线房间也不会断。
                </div>
              </template>
              <div v-else class="hint">平台按区域挑延迟低、负载轻的节点，并自动留冗余。</div>
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

          <button class="btn btn-primary home-cta" :disabled="busy" type="button" @click="doCreate">
            <span v-if="busy" class="spinner" />
            <span>创建并连接</span>
          </button>
          <p class="hint center">创建后会立刻为你建立虚拟网络，并把联机地址显示在房间页上。</p>
        </template>

        <!-- ------------------------------------------------------- 加入房间 -->
        <template v-else-if="pane === 'join'">
          <div class="pane-head">
            <button class="btn btn-ghost btn-sm" type="button" @click="open('menu')">← 返回</button>
            <span class="pane-title">{{ PANE_TITLE.join }}</span>
          </div>

          <div v-if="error" class="alert alert-danger">{{ error }}</div>

          <div class="stack">
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

          <button class="btn btn-primary home-cta" :disabled="busy" type="button" @click="doJoin">
            <span v-if="busy" class="spinner" />
            <span>加入房间</span>
          </button>

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

        <!-- ------------------------------------------------------- 公共广场 -->
        <template v-else>
          <div class="pane-head">
            <button class="btn btn-ghost btn-sm" type="button" @click="open('menu')">← 返回</button>
            <span class="pane-title">{{ PANE_TITLE.plaza }}</span>
          </div>
          <PublicPlaza />
        </template>
      </div>
    </div>

    <div class="home-foot mono">McLink{{ version ? ` v${version}` : '' }}</div>
  </div>
</template>

<style scoped>
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
</style>
