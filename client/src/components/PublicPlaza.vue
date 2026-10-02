<script setup lang="ts">
/**
 * 公共房间广场：列出 `visibility = public` 的房间，支持按区域筛选与直接加入。
 *
 * `GET /rooms/public` 是匿名可读接口（服务端已剥掉网络名等凭证），
 * 所以这个面板在登录页也能安全展示；只是「加入」需要登录，
 * 未登录时用 `can-join=false` 关掉按钮。
 *
 * 为什么是**两级**（列表 → 详情）而不是一张宽表格：
 * 客户端窗口只有 460px，内容列宽 344px。原来那张 6 列表格（房间/房主/区域/在线/
 * 加入方式/操作）在这个宽度下必然把信息挤掉——实测「房主」被截成省略号、
 * 加入码按钮和加入按钮换行、区域列全是「自动选择（延迟优先）」把有用信息盖住。
 * ui-ux-pro-max 的响应式规则写得很直接：窄容器里别硬塞宽表格，改用卡片/列表布局。
 *
 * 所以列表级每行只留「一眼判断要不要进」的四件事：
 * 房间名、房主 · 区域 · 在线、加入方式徽标、进入箭头；
 * 加入码、网段、可见性、加入按钮这些「进来之后才有用」的信息全部放详情级，
 * 并且带一个明确的「← 返回」（返回必须可预测，这是导航的首要规则）。
 */
import { computed, onMounted, ref } from 'vue';
import { REGIONS, regionLabel, Routes, type RegionDef, type Room } from '@mclink/shared';
import { copyText } from '../lib/clipboard.ts';
import { api, friendlyError } from '../lib/api.ts';
import { clientState, ensureFreshRelayHints, joinRoom } from '../lib/store.ts';

const props = withDefaults(defineProps<{ canJoin?: boolean }>(), { canJoin: true });

const rooms = ref<Room[]>([]);
const total = ref(0);
const zone = ref('');
const loading = ref(true);
const error = ref('');
const busyId = ref('');
/** 正在看详情的房间；null = 停在列表级 */
const selected = ref<Room | null>(null);
const password = ref('');
const copied = ref('');

// 未登录时 clientState.regions 还是空的（那要登录后才会拉），退回内置区域表
const zones = computed<readonly RegionDef[]>(() => (clientState.regions.length > 0 ? clientState.regions : REGIONS));

const accessLabel = (room: Room): string =>
  room.access === 'open' ? '直接加入' : room.access === 'password' ? '需要密码' : '需房主审批';
const accessClass = (room: Room): string =>
  room.access === 'open' ? 'badge-ok' : room.access === 'password' ? 'badge-warn' : 'badge-info';

/**
 * 行内的区域短名。
 *
 * `regionLabel('auto')` 是「自动选择（延迟优先）」——那是下拉框里的说法，
 * 塞进每行就是把真正有信息的区域名挤没了（实测 13 行里 13 个同款长句）。
 * 括号里的解释只在筛选下拉里出现一次就够了；详情页再给完整说法。
 */
const shortRegion = (id: string): string => (id === 'auto' ? '自动' : regionLabel(id));

/** 详情页的加入方式说明：审批制要多告诉玩家一句"提交后要等" */
const accessHint = (room: Room): string =>
  room.access === 'open'
    ? '任何人都能用这个加入码进来。'
    : room.access === 'password'
      ? '这个房间需要密码，房主会把密码单独告诉你。'
      : '提交申请后会进入等待队列，房主同意后你才会连上虚拟网络。';

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const res = await api.get<{ rooms: Room[]; total: number }>(Routes.roomPublic, {
      query: { limit: 40, zone: zone.value || undefined },
    });
    rooms.value = res.rooms;
    total.value = res.total;
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    loading.value = false;
  }
}

async function doJoin(room: Room, pw?: string): Promise<void> {
  if (!props.canJoin) return;
  busyId.value = room.id;
  error.value = '';
  try {
    // 与建房/输码进房同一条规则：进房前保证手上有一份**不太旧**的测速结果
    //（没有/超过保鲜期就测一轮，最多等 RELAY_PROBE_WAIT_MS），好让主控按本机延迟
    // 加负载折价给这名成员分中继。探测失败或超时照常进房 —— 测速永远挡不住进房，
    // 见 store.ts 的 ensureFreshRelayHints。
    await ensureFreshRelayHints();
    await joinRoom(room.code, pw);
    password.value = '';
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busyId.value = '';
  }
}

function pick(room: Room): void {
  // 需要密码的房间不直接发请求，先在详情页就地展开输入框
  if (room.access === 'password' && !password.value) return;
  void doJoin(room, password.value || undefined);
}

/** 复制一段文本并给出短暂的"已复制"反馈 */
async function copy(text: string, key: string, label: string): Promise<void> {
  try {
    const ok = await copyText(text);
    if (!ok) throw new Error('剪贴板不可用');
    copied.value = key;
    window.setTimeout(() => {
      if (copied.value === key) copied.value = '';
    }, 1600);
  } catch {
    error.value = `${label}复制失败，请手动记下。`;
  }
}

/** 邀请信息：一次把加入码与玩法说清楚，方便玩家直接粘给朋友 */
function inviteText(room: Room): string {
  return [
    `【McLink 房间邀请】${room.name}`,
    `加入码：${room.code}${room.access === 'password' ? '（需要密码，我另外发你）' : ''}`,
    '怎么进：打开 McLink 客户端 → 加入房间 → 填上面的加入码。',
  ].join('\n');
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="stack">
    <!-- ======================================================= 列表级 -->
    <template v-if="!selected">
      <div class="card">
        <div class="row-between wrap" style="margin-bottom: 10px">
          <div>
            <div style="font-weight: 620">公共房间广场</div>
            <div class="hint">
              公开房间可以直接加入（无需加好友）
              <template v-if="!loading"> · 共 {{ total }} 个</template>
            </div>
          </div>
          <div class="row">
            <select v-model="zone" class="select" style="width: auto" @change="load()">
              <option value="">全部区域</option>
              <option v-for="z in zones" :key="z.id" :value="z.id">{{ z.label }}</option>
            </select>
            <button class="btn btn-sm" :disabled="loading" @click="load()">刷新</button>
          </div>
        </div>

        <div v-if="error" class="alert alert-danger" style="margin-bottom: 10px">
          <span class="grow">{{ error }}</span>
          <button class="btn btn-ghost btn-sm" @click="load()">重试</button>
        </div>

        <!-- 三态：加载中 -->
        <div v-if="loading" class="row" style="padding: var(--s-4) 0">
          <span class="spinner" />
          <span class="muted">正在读取大厅…</span>
        </div>

        <!-- 三态：空数据 -->
        <div v-else-if="rooms.length === 0" class="empty">
          当前没有公开房间。你可以自己开一个（建房时可见性选「公开在大厅」），别人就能在这里看到。
        </div>

        <!-- 三态：有数据 —— 一行一个房间，整行可点 -->
        <div v-else class="plaza-list">
          <button
            v-for="room in rooms"
            :key="room.id"
            class="plaza-row"
            type="button"
            @click="selected = room"
          >
            <span class="grow plaza-main">
              <span class="plaza-name">{{ room.name }}</span>
              <span class="plaza-sub">
                {{ room.hostDisplayName }} · {{ shortRegion(room.zone) }} · 在线
                <span class="mono">{{ room.onlineMembers }}/{{ room.policy.maxPlayers }}</span>
              </span>
            </span>
            <span class="badge" :class="accessClass(room)">{{ accessLabel(room) }}</span>
            <span class="plaza-chevron" aria-hidden="true">›</span>
          </button>
        </div>
      </div>
    </template>

    <!-- ======================================================= 详情级 -->
    <template v-else>
      <div class="pane-head">
        <!-- 外层还有一个「← 返回 公共广场」（离开广场面板），所以这一层必须写清楚是回列表，
             两个一模一样的「← 返回」叠在一起等于没有层级 -->
        <button class="btn btn-ghost btn-sm" type="button" @click="selected = null">← 返回列表</button>
        <span class="pane-title">房间详情</span>
      </div>

      <div v-if="error" class="alert alert-danger">
        <span class="grow">{{ error }}</span>
        <button class="btn btn-ghost btn-sm" @click="error = ''">关闭</button>
      </div>

      <div class="card stack">
        <div class="row-between wrap" style="gap: var(--s-2)">
          <span class="plaza-name" style="font-size: var(--fs-lg)">{{ selected.name }}</span>
          <span class="badge" :class="accessClass(selected)">{{ accessLabel(selected) }}</span>
        </div>

        <hr class="divider" />

        <!-- 标签/值一行一对：复用设置页「运行环境」那套写法（客户端没有 web 端的 .kv-* 类） -->
        <div class="row-between">
          <span class="faint">房主</span><span>{{ selected.hostDisplayName }}</span>
        </div>
        <div class="row-between">
          <span class="faint">区域</span><span>{{ regionLabel(selected.zone) }}</span>
        </div>
        <div class="row-between">
          <span class="faint">在线</span>
          <span class="mono">{{ selected.onlineMembers }}/{{ selected.policy.maxPlayers }}</span>
        </div>
        <div class="row-between">
          <span class="faint">网段</span><span class="mono">{{ selected.subnet }}</span>
        </div>
        <div class="row-between">
          <span class="faint">可见性</span>
          <span>{{ selected.visibility === 'public' ? '公开在大厅' : '仅凭加入码' }}</span>
        </div>
        <div class="row-between">
          <span class="faint">加入码</span>
          <span class="mono" style="letter-spacing: 0.14em">{{ selected.code }}</span>
        </div>
        <div class="hint">{{ accessHint(selected) }}</div>

        <div v-if="selected.access === 'password'" class="field">
          <label class="label">房间密码</label>
          <input v-model="password" class="input" type="password" placeholder="房主给你的密码" />
        </div>

        <div class="ops">
          <button
            v-if="canJoin"
            class="btn btn-primary"
            type="button"
            :disabled="busyId === selected.id || (selected.access === 'password' && !password)"
            @click="pick(selected)"
          >
            <span v-if="busyId === selected.id" class="spinner" />
            <span>{{ selected.access === 'approval' ? '申请加入' : '加入房间' }}</span>
          </button>
          <button class="btn" type="button" @click="copy(selected.code, `code:${selected.id}`, '加入码')">
            {{ copied === `code:${selected.id}` ? '已复制' : '复制加入码' }}
          </button>
          <button
            class="btn btn-ghost"
            type="button"
            @click="copy(inviteText(selected), `invite:${selected.id}`, '邀请信息')"
          >
            {{ copied === `invite:${selected.id}` ? '已复制' : '复制邀请信息' }}
          </button>
        </div>
        <p v-if="!canJoin" class="hint">登录后就能加入房间。加入码与邀请信息现在就可以复制。</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 一行一个房间：整行是按钮，点击区域覆盖全行（窄窗里别只让文字可点） */
.plaza-list {
  display: flex;
  flex-direction: column;
}
.plaza-row {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  width: 100%;
  min-height: 44px; /* 触控/鼠标都好点：ui-ux-pro-max 的交互规则要求 ≥44px */
  padding: 8px var(--s-2);
  border: 0;
  border-top: 1px solid var(--rule-faint);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.plaza-row:first-child {
  border-top: 0;
}
.plaza-row:hover {
  background: var(--surface-hair);
}
/* 键盘用户必须看得见焦点在哪 */
.plaza-row:focus-visible {
  outline: 2px solid var(--signal);
  outline-offset: -2px;
}
.plaza-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.plaza-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.plaza-sub {
  font-size: var(--fs-xs);
  color: var(--paper-faint);
  overflow-wrap: anywhere;
}
.plaza-chevron {
  flex: none;
  color: var(--paper-faint);
  font-size: var(--fs-lg);
  line-height: 1;
}
</style>
