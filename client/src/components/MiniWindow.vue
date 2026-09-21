<script setup lang="ts">
/**
 * 迷你窗视图（`dist/index.html?mini=1`）。
 *
 * 它跑在**另一个渲染进程**里，拿不到主窗的 Vue 状态，因此数据来自
 * localStorage 的 `mclink.mini.state`（由 store.ts 写入，见 lib/mini.ts）。
 *
 * `storage` 事件只在「其它文档」里触发且 file:// 下的行为不完全可靠，
 * 所以额外加了一个 1.5s 的轻量轮询兜底 —— 代价是一个 JSON.parse，
 * 换来的是「主窗改了地址，迷你窗一定跟得上」。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { formatRelativeTime } from '@mclink/shared';
import { readMiniState, type MiniState } from '../lib/mini.ts';

const state = ref<MiniState | null>(null);
const copied = ref(false);
const now = ref(Date.now());
let timer: number | null = null;

function refresh(): void {
  state.value = readMiniState();
  now.value = Date.now();
}

const address = computed(() => state.value?.hostVirtualIp ?? null);
const statusText = computed(() => {
  switch (state.value?.state) {
    case 'running':
      return '虚拟网络已连接';
    case 'starting':
      return '正在建立连接…';
    case 'error':
      return '连接异常，请回主窗查看';
    default:
      return state.value?.roomId ? '未连接' : '还没进入房间';
  }
});
const statusDot = computed(() => {
  switch (state.value?.state) {
    case 'running':
      return 'dot-ok';
    case 'starting':
      return 'dot-warn';
    case 'error':
      return 'dot-danger';
    default:
      return 'dot-idle';
  }
});

async function copy(): Promise<void> {
  if (!address.value) return;
  try {
    await navigator.clipboard.writeText(address.value);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1600);
  } catch {
    copied.value = false;
  }
}

function openMain(): void {
  if (window.mclink.mini) void window.mclink.mini.close();
}

onMounted(() => {
  refresh();
  window.addEventListener('storage', refresh);
  timer = window.setInterval(refresh, 1500);
});

onUnmounted(() => {
  window.removeEventListener('storage', refresh);
  if (timer !== null) window.clearInterval(timer);
});
</script>

<template>
  <div class="mini">
    <div class="mini-head">
      <span class="dot" :class="statusDot" />
      <span class="mini-title truncate">{{ state?.roomName ?? 'mclink' }}</span>
      <span v-if="state?.code" class="badge badge-brand mini-code">{{ state.code }}</span>
      <span class="grow" />
      <button class="btn btn-sm btn-ghost no-drag" @click="openMain()">打开主窗口</button>
    </div>

    <div class="mini-addr">
      <span class="mini-addr-value mono truncate">{{ address ?? '等待分配地址…' }}</span>
      <button class="btn btn-sm btn-primary no-drag" :disabled="!address" @click="copy()">
        {{ copied ? '已复制' : '复制' }}
      </button>
    </div>

    <div class="mini-foot">
      <span class="faint">{{ statusText }}</span>
      <span class="grow" />
      <span v-if="state" class="faint">{{ formatRelativeTime(state.updatedAt, now) }}更新</span>
    </div>
  </div>
</template>

<style scoped>
.mini {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 4px;
  padding: 8px 10px;
  background: var(--grad-hero);
  /* 无边框窗口：整块区域可拖动 */
  -webkit-app-region: drag;
  user-select: none;
}
.no-drag,
button {
  -webkit-app-region: no-drag;
}
.mini-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-sm);
}
.mini-title {
  font-weight: 620;
  max-width: 120px;
}
.mini-code {
  font-family: var(--font-mono);
}
.mini-addr {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.mini-addr-value {
  flex: 1;
  min-width: 0;
  font-size: 17px;
  font-weight: 650;
  color: var(--brand);
  user-select: text;
}
.mini-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
}
</style>
