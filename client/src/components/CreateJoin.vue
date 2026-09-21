<script setup lang="ts">
/** 未进房时的主界面：我的房间列表 + 创建房间 + 凭加入码进房 */
import { computed, onMounted, ref } from 'vue';
import { REGIONS, type Room } from '@mclink/shared';
import { clientState, createRoom, joinRoom, loadRooms, reenterRoom } from '../lib/store.ts';
import { friendlyError } from '../lib/api.ts';
import PublicPlaza from './PublicPlaza.vue';
import RoomShortcuts from './RoomShortcuts.vue';

const code = ref('');
const joinPassword = ref('');
const showCreate = ref(false);
const busy = ref(false);
const error = ref('');

const form = ref({
  name: `房间 ${clientState.user?.displayName ?? ''}`.trim(),
  zone: 'auto',
  access: 'open' as 'open' | 'password' | 'approval',
  password: '',
  visibility: 'public' as 'public' | 'hidden',
  maxPlayers: 8,
});

const regions = computed(() => clientState.regions.filter((r) => r.id !== 'auto' || true));
const allRooms = computed<Room[]>(() => [...clientState.hosted, ...clientState.joined]);

onMounted(() => {
  void loadRooms().catch(() => {});
});

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
    showCreate.value = false;
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
  <div class="view">
    <div v-if="error" class="alert alert-danger">{{ error }}</div>

    <div class="grid-2">
      <!-- 加入房间 -->
      <div class="card">
        <div style="font-weight: 620; font-size: var(--fs-lg)">加入朋友的房间</div>
        <div class="hint" style="margin-bottom: 12px">向房主要 6 位加入码，填进来即可</div>

        <div class="stack">
          <div class="field">
            <label class="label">房间加入码</label>
            <input
              v-model="code"
              class="input mono"
              maxlength="6"
              placeholder="例如 K7QM2P"
              style="text-transform: uppercase; letter-spacing: 0.2em; font-size: 18px"
              @keyup.enter="doJoin"
            />
          </div>
          <div class="field">
            <label class="label">房间密码（若房主设置了）</label>
            <input v-model="joinPassword" class="input" type="password" @keyup.enter="doJoin" />
          </div>
          <button class="btn btn-primary btn-lg btn-block" :disabled="busy" @click="doJoin">
            <span v-if="busy" class="spinner" />
            <span>加入房间</span>
          </button>
        </div>
      </div>

      <!-- 创建房间 -->
      <div class="card">
        <div class="row-between">
          <div>
            <div style="font-weight: 620; font-size: var(--fs-lg)">自己开一个房间</div>
            <div class="hint" style="margin-bottom: 12px">你是房主，可以先在游戏里开好存档再邀请朋友</div>
          </div>
        </div>

        <div v-if="!showCreate" class="stack">
          <button class="btn btn-lg btn-block" @click="showCreate = true">创建新房间</button>
          <div class="hint">创建后会立刻为你建立虚拟网络，并把「联机地址」显示出来。</div>
        </div>

        <div v-else class="stack">
          <div class="field">
            <label class="label">房间名称</label>
            <input v-model="form.name" class="input" maxlength="32" />
          </div>
          <div class="grid-2" style="gap: 12px">
            <div class="field">
              <label class="label">联机区域</label>
              <select v-model="form.zone" class="select">
                <option v-for="r in regions" :key="r.id" :value="r.id">
                  {{ r.label }}{{ r.onlineNodes > 0 ? ` · ${r.onlineNodes} 个节点` : '' }}
                </option>
              </select>
            </div>
            <div class="field">
              <label class="label">最大人数</label>
              <input v-model.number="form.maxPlayers" class="input" type="number" min="2" max="64" />
            </div>
          </div>
          <div class="grid-2" style="gap: 12px">
            <div class="field">
              <label class="label">加入方式</label>
              <select v-model="form.access" class="select">
                <option value="open">任何人凭加入码</option>
                <option value="password">需要房间密码</option>
                <option value="approval">需要我审批</option>
              </select>
            </div>
            <div class="field">
              <label class="label">可见性</label>
              <select v-model="form.visibility" class="select">
                <option value="public">公开在大厅</option>
                <option value="hidden">仅凭加入码</option>
              </select>
            </div>
          </div>
          <div v-if="form.access === 'password'" class="field">
            <label class="label">房间密码</label>
            <input v-model="form.password" class="input" />
          </div>
          <div class="row">
            <button class="btn btn-primary grow" :disabled="busy" @click="doCreate">
              <span v-if="busy" class="spinner" />
              <span>创建并连接</span>
            </button>
            <button class="btn btn-ghost" @click="showCreate = false">取消</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 我的房间 -->
    <div class="card">
      <div class="row-between" style="margin-bottom: 12px">
        <div style="font-weight: 620">我的房间</div>
        <button class="btn btn-sm btn-ghost" @click="loadRooms()">刷新</button>
      </div>

      <table v-if="allRooms.length > 0" class="table">
        <thead>
          <tr>
            <th>名称</th>
            <th>加入码</th>
            <th>区域</th>
            <th>人数</th>
            <th>角色</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="room in allRooms" :key="room.id">
            <td>{{ room.name }}</td>
            <td class="mono">{{ room.code }}</td>
            <td class="faint">{{ room.zone }}</td>
            <td class="table-num">{{ room.onlineMembers }}/{{ room.policy.maxPlayers }}</td>
            <td>
              <span class="badge" :class="room.hostUserId === clientState.user?.id ? 'badge-brand' : 'badge-neutral'">
                {{ room.hostUserId === clientState.user?.id ? '房主' : '成员' }}
              </span>
            </td>
            <td style="text-align: right">
              <button class="btn btn-sm" :disabled="busy" @click="resume(room)">进入</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">还没有房间。创建一个，或者用朋友的加入码进入。</div>
    </div>

    <!-- 收藏与最近进入过的房间（本机记录，一键重进） -->
    <RoomShortcuts />

    <!-- 公共房间广场：公开房间可以不用加入码直接进 -->
    <PublicPlaza />

    <div class="card card-tight">
      <div class="hint">
        联机步骤：① 自己先在《我的世界》里开好世界并「对局域网开放」（单人存档 → Esc → 对局域网开放）；
        ② 用本客户端创建房间；③ 把界面上的「联机地址」和加入码发给朋友；
        ④ 朋友启动游戏 → 多人游戏 → 直接连接 → 粘贴该地址。
      </div>
    </div>
  </div>
</template>
