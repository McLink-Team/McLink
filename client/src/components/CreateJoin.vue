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
import { REGIONS, regionLabel, type Room } from '@mclink/shared';
import { clientState, createRoom, joinRoom, loadRooms, reenterRoom } from '../lib/store.ts';
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
