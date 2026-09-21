<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { CoreLogEntry } from '../lib/core-types.ts';
import { clientState, openLogsFolder } from '../lib/store.ts';

const props = defineProps<{ logs: CoreLogEntry[] }>();
const emit = defineEmits<{ copy: [text: string] }>();

const box = ref<HTMLElement | null>(null);
const autoScroll = ref(true);

const text = computed(() =>
  props.logs
    .map((l) => `${l.ts.slice(11, 23)} ${l.line}`)
    .join('\n'),
);

watch(
  () => props.logs.length,
  async () => {
    if (!autoScroll.value) return;
    await nextTick();
    if (box.value) box.value.scrollTop = box.value.scrollHeight;
  },
);
</script>

<template>
  <div class="view">
    <div class="card">
      <div class="row-between" style="margin-bottom: 12px">
        <div>
          <div style="font-weight: 620">EasyTier 运行日志</div>
          <div class="hint">
            来自本地 easytier-core 进程；
            <span class="mono">{{ clientState.coreStatus?.configFile ?? '尚未启动' }}</span>
          </div>
        </div>
        <div class="row">
          <label class="row" style="gap: 6px; font-size: var(--fs-sm)">
            <input v-model="autoScroll" type="checkbox" />
            <span class="muted">自动滚动</span>
          </label>
          <button class="btn btn-sm" @click="emit('copy', text)">复制全部</button>
          <button class="btn btn-sm" @click="openLogsFolder()">打开日志目录</button>
        </div>
      </div>

      <div ref="box" class="logs">
        <template v-if="logs.length > 0">
          <div v-for="(l, i) in logs" :key="i" :class="l.stream === 'stderr' ? 'log-stderr' : l.stream === 'info' ? 'log-info' : ''">
            {{ l.ts.slice(11, 23) }} {{ l.line }}
          </div>
        </template>
        <div v-else class="faint">暂无日志。连接房间后这里会显示 easytier-core 的输出。</div>
      </div>
    </div>

    <div class="card card-tight">
      <div class="grid-3">
        <div>
          <div class="faint" style="font-size: var(--fs-xs)">核心路径</div>
          <div class="mono truncate">{{ clientState.coreStatus?.coreBin ?? '-' }}</div>
        </div>
        <div>
          <div class="faint" style="font-size: var(--fs-xs)">RPC 端口</div>
          <div class="mono">{{ clientState.coreStatus?.rpcPortal ?? '-' }}</div>
        </div>
        <div>
          <div class="faint" style="font-size: var(--fs-xs)">进程 PID</div>
          <div class="mono">{{ clientState.coreStatus?.pid ?? '-' }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
