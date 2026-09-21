<script setup lang="ts">
import { computed } from 'vue';
import type { CoreState } from '../lib/core-types.ts';

const props = defineProps<{
  state: CoreState;
  tunnel: number;
}>();

const label = computed(() => {
  switch (props.state) {
    case 'running':
      return '虚拟网络已连接';
    case 'starting':
      return '正在连接…';
    case 'error':
      return '连接异常';
    default:
      return '未连接';
  }
});

const tone = computed(() => {
  switch (props.state) {
    case 'running':
      return 'ok';
    case 'starting':
      return 'warn';
    case 'error':
      return 'danger';
    default:
      return 'neutral';
  }
});
</script>

<template>
  <span class="badge" :class="`badge-${tone}`">
    <span class="dot" :class="`dot-${tone === 'neutral' ? 'idle' : tone}`" />
    {{ label }}
    <span v-if="tunnel > 0" class="faint">· {{ tunnel }} 个节点</span>
  </span>
</template>
