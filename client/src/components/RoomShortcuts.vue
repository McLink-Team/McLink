<script setup lang="ts">
/**
 * 收藏与「最近进入」的房间。
 *
 * 数据全部来自本机 localStorage（见 lib/shortcuts.ts），不经过主控：
 * 只记房间名、加入码与上次的联机地址，重进时仍然要用加入码/票据换取新凭证。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { formatRelativeTime } from '@mclink/shared';
import { copyText } from '../lib/clipboard.ts';
import { friendlyError } from '../lib/api.ts';
import { reenterRoom } from '../lib/store.ts';
import {
  clearRecent,
  forgetFavorite,
  loadFavorites,
  loadRecent,
  removeRecent,
  shortcutsRevision,
  type RoomShortcut,
} from '../lib/shortcuts.ts';

const favorites = computed<RoomShortcut[]>(() => {
  void shortcutsRevision.value;
  return loadFavorites();
});
const recent = computed<RoomShortcut[]>(() => {
  void shortcutsRevision.value;
  return loadRecent();
});

const busyId = ref('');
const error = ref('');
const copied = ref('');
const now = ref(Date.now());
let clock: number | null = null;

async function enter(entry: RoomShortcut): Promise<void> {
  busyId.value = entry.roomId;
  error.value = '';
  try {
    // 走正常票据流程：旧票据可能早就失效了，必须重新签发
    await reenterRoom(entry.roomId);
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busyId.value = '';
  }
}

async function copy(entry: RoomShortcut, tag: string): Promise<void> {
  if (!entry.lastAddress) return;
  try {
    const ok = await copyText(entry.lastAddress);
    if (!ok) throw new Error("剪贴板不可用");
    copied.value = tag;
    window.setTimeout(() => {
      if (copied.value === tag) copied.value = '';
    }, 1600);
  } catch {
    error.value = '复制失败，请手动输入地址。';
  }
}

onMounted(() => {
  clock = window.setInterval(() => {
    now.value = Date.now();
  }, 30_000);
});

onUnmounted(() => {
  if (clock !== null) window.clearInterval(clock);
});
</script>

<template>
  <div class="grid-2">
    <div class="card">
      <div class="row-between" style="margin-bottom: 10px">
        <div style="font-weight: 620">收藏的房间</div>
        <span class="badge badge-neutral">{{ favorites.length }}</span>
      </div>

      <div v-if="error" class="alert alert-danger" style="margin-bottom: 10px">
        <span class="grow">{{ error }}</span>
        <button class="btn btn-ghost btn-sm" @click="error = ''">关闭</button>
      </div>

      <div v-if="favorites.length === 0" class="empty">
        还没有收藏。进房后在房间页点「收藏」就会出现在这里，方便下次一键重进。
      </div>
      <div v-else class="stack" style="gap: var(--s-2)">
        <div v-for="f in favorites" :key="f.roomId" class="row-between shortcut">
          <div class="grow">
            <div class="row" style="gap: 6px">
              <span class="truncate">{{ f.name }}</span>
              <span class="badge badge-brand mono">{{ f.code }}</span>
            </div>
            <div class="hint">
              联机地址 <span class="mono">{{ f.lastAddress ?? '未知（首次进入后才有）' }}</span> ·
              {{ formatRelativeTime(f.lastSeenAt, now) }}进入
            </div>
          </div>
          <div class="row" style="gap: 4px">
            <button class="btn btn-sm" :disabled="busyId === f.roomId" @click="enter(f)">
              <span v-if="busyId === f.roomId" class="spinner" />
              <span>进入</span>
            </button>
            <button class="btn btn-sm btn-ghost" :disabled="!f.lastAddress" @click="copy(f, `fav-${f.roomId}`)">
              {{ copied === `fav-${f.roomId}` ? '已复制' : '复制地址' }}
            </button>
            <button class="btn btn-sm btn-ghost" title="取消收藏" @click="forgetFavorite(f.roomId)">★</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="row-between" style="margin-bottom: 10px">
        <div style="font-weight: 620">最近进入</div>
        <div class="row">
          <span class="badge badge-neutral">{{ recent.length }}</span>
          <button v-if="recent.length > 0" class="btn btn-sm btn-ghost" @click="clearRecent()">清空</button>
        </div>
      </div>

      <div v-if="recent.length === 0" class="empty">还没有进入过房间。</div>
      <div v-else class="stack" style="gap: var(--s-2)">
        <div v-for="r in recent" :key="r.roomId" class="row-between shortcut">
          <div class="grow">
            <div class="row" style="gap: 6px">
              <span class="truncate">{{ r.name }}</span>
              <span class="badge badge-neutral mono">{{ r.code }}</span>
            </div>
            <div class="hint">
              <span class="mono">{{ r.lastAddress ?? '未知' }}</span> · {{ formatRelativeTime(r.lastSeenAt, now) }}
            </div>
          </div>
          <div class="row" style="gap: 4px">
            <button class="btn btn-sm" :disabled="busyId === r.roomId" @click="enter(r)">
              <span v-if="busyId === r.roomId" class="spinner" />
              <span>重进</span>
            </button>
            <button class="btn btn-sm btn-ghost" :disabled="!r.lastAddress" @click="copy(r, `recent-${r.roomId}`)">
              {{ copied === `recent-${r.roomId}` ? '已复制' : '复制地址' }}
            </button>
            <button class="btn btn-sm btn-ghost" title="从列表移除" @click="removeRecent(r.roomId)">✕</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shortcut {
  gap: var(--s-2);
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--surface-hair);
}
</style>
