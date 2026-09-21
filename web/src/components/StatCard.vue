<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    hint?: string;
    /** 与上一次相比的变化百分比；正数偏绿，负数偏红（除非 invert） */
    delta?: number | null;
    /** delta 为「越小越好」时反转颜色（例如延迟、错误率） */
    invert?: boolean;
    accent?: 'brand' | 'accent' | 'violet' | 'ok' | 'warn' | 'danger';
  }>(),
  { accent: 'brand', delta: null, invert: false },
);

const accentColor = computed(() => {
  switch (props.accent) {
    case 'accent':
      return 'var(--accent)';
    case 'violet':
      return 'var(--violet)';
    case 'ok':
      return 'var(--ok)';
    case 'warn':
      return 'var(--warn)';
    case 'danger':
      return 'var(--danger)';
    default:
      return 'var(--brand)';
  }
});

const deltaTone = computed(() => {
  if (props.delta === null || props.delta === undefined || !Number.isFinite(props.delta)) return 'neutral';
  const positive = props.delta >= 0;
  const good = props.invert ? !positive : positive;
  return good ? 'ok' : 'danger';
});

const deltaText = computed(() => {
  if (props.delta === null || props.delta === undefined || !Number.isFinite(props.delta)) return '';
  const sign = props.delta > 0 ? '+' : '';
  return `${sign}${props.delta.toFixed(1)}%`;
});
</script>

<template>
  <div class="stat card card-hover">
    <div class="stat-accent" :style="{ background: accentColor }" />
    <div class="stat-label">{{ label }}</div>
    <div class="stat-value">{{ value }}</div>
    <div class="stat-foot">
      <span v-if="deltaText" class="stat-delta" :class="`stat-delta-${deltaTone}`">{{ deltaText }}</span>
      <span v-if="hint" class="stat-hint">{{ hint }}</span>
    </div>
  </div>
</template>

<style scoped>
.stat {
  position: relative;
  overflow: hidden;
  padding: var(--s-4) var(--s-5);
}
.stat-accent {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  opacity: 0.85;
}
.stat-label {
  font-size: var(--fs-xs);
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.stat-value {
  font-size: var(--fs-2xl);
  font-weight: 680;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
}
.stat-foot {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  min-height: 18px;
  margin-top: 2px;
}
.stat-delta {
  font-size: var(--fs-xs);
  font-weight: 600;
}
.stat-delta-ok {
  color: var(--ok);
}
.stat-delta-danger {
  color: var(--danger);
}
.stat-hint {
  font-size: var(--fs-xs);
  color: var(--text-faint);
}
</style>
