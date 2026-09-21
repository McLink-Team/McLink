<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 语义色；neutral 用于普通标签 */
    tone?: 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'brand';
    /** 左侧圆点，常用于在线状态 */
    dot?: boolean;
    /** 呼吸效果，用于「在线」这类需要吸引注意的状态 */
    pulse?: boolean;
  }>(),
  { tone: 'neutral', dot: false, pulse: false },
);

const dotColor = computed(() => {
  switch (props.tone) {
    case 'ok':
      return 'var(--ok)';
    case 'warn':
      return 'var(--warn)';
    case 'danger':
      return 'var(--danger)';
    case 'info':
      return 'var(--info)';
    case 'brand':
      return 'var(--brand)';
    default:
      return 'var(--text-faint)';
  }
});
</script>

<template>
  <span class="badge" :class="`badge-${tone}`">
    <span v-if="dot" class="badge-dot" :class="{ pulse: pulse }" :style="{ background: dotColor, color: dotColor }" />
    <slot />
  </span>
</template>

<style scoped>
.badge-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}
</style>
