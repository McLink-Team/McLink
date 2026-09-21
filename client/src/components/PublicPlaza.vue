<script setup lang="ts">
/**
 * 公共房间广场：列出 `visibility = public` 的房间，支持按区域筛选与直接加入。
 *
 * `GET /rooms/public` 是匿名可读接口（服务端已剥掉网络名等凭证），
 * 所以这个面板在登录页也能安全展示；只是「加入」需要登录，
 * 未登录时用 `can-join=false` 关掉按钮。
 */
import { computed, onMounted, ref } from 'vue';
import { REGIONS, regionLabel, Routes, type RegionDef, type Room } from '@mclink/shared';
import { copyText } from '../lib/clipboard.ts';
import { api, friendlyError } from '../lib/api.ts';
import { clientState, joinRoom } from '../lib/store.ts';

const props = withDefaults(defineProps<{ canJoin?: boolean }>(), { canJoin: true });

const rooms = ref<Room[]>([]);
const total = ref(0);
const zone = ref('');
const loading = ref(true);
const error = ref('');
const busyId = ref('');
/** 正在等待输入密码的房间 id */
const passwordFor = ref('');
const password = ref('');
const copied = ref('');

// 未登录时 clientState.regions 还是空的（那要登录后才会拉），退回内置区域表
const zones = computed<readonly RegionDef[]>(() => (clientState.regions.length > 0 ? clientState.regions : REGIONS));

const accessLabel = (room: Room): string =>
  room.access === 'open' ? '直接加入' : room.access === 'password' ? '需要密码' : '需房主审批';
const accessClass = (room: Room): string =>
  room.access === 'open' ? 'badge-ok' : room.access === 'password' ? 'badge-warn' : 'badge-info';

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
    await joinRoom(room.code, pw);
    passwordFor.value = '';
    password.value = '';
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busyId.value = '';
  }
}

function pick(room: Room): void {
  if (room.access === 'password') {
    passwordFor.value = passwordFor.value === room.id ? '' : room.id;
    password.value = '';
    return;
  }
  void doJoin(room);
}

async function copyCode(code: string): Promise<void> {
  try {
    const ok = await copyText(code);
    if (!ok) throw new Error("剪贴板不可用");
    copied.value = code;
    window.setTimeout(() => {
      if (copied.value === code) copied.value = '';
    }, 1600);
  } catch {
    error.value = '复制失败，请手动记下加入码。';
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
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

    <table v-else class="table">
      <thead>
        <tr>
          <th>房间</th>
          <th>房主</th>
          <th>区域</th>
          <th class="table-num">在线</th>
          <th>加入方式</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <template v-for="room in rooms" :key="room.id">
          <tr>
            <td>
              <div class="truncate" style="max-width: 220px">{{ room.name }}</div>
              <div class="faint mono" style="font-size: var(--fs-xs)">{{ room.subnet }}</div>
            </td>
            <td class="truncate" style="max-width: 140px">{{ room.hostDisplayName }}</td>
            <td class="faint">{{ regionLabel(room.zone) }}</td>
            <td class="table-num">{{ room.onlineMembers }}/{{ room.policy.maxPlayers }}</td>
            <td><span class="badge" :class="accessClass(room)">{{ accessLabel(room) }}</span></td>
            <td style="text-align: right; white-space: nowrap">
              <button class="btn btn-sm btn-ghost" @click="copyCode(room.code)">
                {{ copied === room.code ? '已复制' : `加入码 ${room.code}` }}
              </button>
              <button v-if="canJoin" class="btn btn-sm" :disabled="busyId === room.id" @click="pick(room)">
                <span v-if="busyId === room.id" class="spinner" />
                <span>加入</span>
              </button>
              <span v-else class="hint">登录后可加入</span>
            </td>
          </tr>
          <tr v-if="passwordFor === room.id">
            <td colspan="6">
              <div class="row">
                <input
                  v-model="password"
                  class="input"
                  type="password"
                  style="max-width: 240px"
                  placeholder="这个房间需要密码"
                  @keyup.enter="doJoin(room, password)"
                />
                <button class="btn btn-primary btn-sm" :disabled="busyId === room.id" @click="doJoin(room, password)">
                  确认加入
                </button>
                <button class="btn btn-sm btn-ghost" @click="passwordFor = ''">取消</button>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <div class="hint" style="margin-top: 10px">
      标注「需房主审批」的房间，提交后会进入等待队列，房主同意后你才会连上虚拟网络。
      大厅列表不包含房间密钥，因此看到房间名不等于能进。
    </div>
  </div>
</template>

<style scoped>
.wrap {
  flex-wrap: wrap;
}
/* 窄窗里表格自己横向滚动，这两列各自占一行、不要折成三四行 */
.table td:nth-child(3),
.table td:nth-child(5) {
  white-space: nowrap;
}
</style>
