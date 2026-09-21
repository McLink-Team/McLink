<script setup lang="ts">
/**
 * 仪表读数。
 *
 * 这里曾经有一条 3px 的左侧彩色色条——那是被 craft floor 明确点名的写法
 * （彩色 border-left 超过 1px 贴在卡片上）。现在改为：**读数本身就是视觉主角**，
 * 层级全靠字号、等宽数字与一条发丝线建立，不再用色块。
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    hint?: string;
    /** 相对上一次的变化百分比；正数偏绿，负数偏红（除非 invert） */
    delta?: number | null;
    /** delta 为「越小越好」时反转颜色（延迟、错误率这类） */
    invert?: boolean;
    /** 语义色：只影响读数本身的颜色，不做底色与色条 */
    tone?: 'default' | 'ok' | 'warn' | 'danger';
    /** 兼容旧调用点：accent 会被映射到 tone，避免控制台页面因改名而报错 */
    accent?: 'brand' | 'accent' | 'violet' | 'ok' | 'warn' | 'danger';
    /** 单位，用更小的字号跟在读数后面 */
    unit?: string;
  }>(),
  { delta: null, invert: false, tone: undefined, accent: undefined, unit: '' },
);

const resolvedTone = computed<'default' | 'ok' | 'warn' | 'danger'>(() => {
  if (props.tone) return props.tone;
  switch (props.accent) {
    case 'ok':
      return 'ok';
    case 'warn':
      return 'warn';
    case 'danger':
      return 'danger';
    default:
      return 'default';
  }
});

const toneColor = computed(() => {
  switch (resolvedTone.value) {
    case 'ok':
      return 'var(--link)';
    case 'warn':
      return 'var(--warn)';
    case 'danger':
      return 'var(--fault)';
    default:
      return 'var(--paper)';
  }
});

const deltaTone = computed(() => {
  if (props.delta === null || props.delta === undefined || !Number.isFinite(props.delta)) return 'none';
  const positive = props.delta >= 0;
  const good = props.invert ? !positive : positive;
  return good ? 'ok' : 'bad';
});

const deltaText = computed(() => {
  if (props.delta === null || props.delta === undefined || !Number.isFinite(props.delta)) return '';
  const sign = props.delta > 0 ? '+' : '';
  return `${sign}${props.delta.toFixed(1)}%`;
});
</script>

<template>
  <div class="stat">
    <div class="stat-label">{{ label }}</div>
    <div class="stat-value" :style="{ color: toneColor }">
      {{ value }}<span v-if="unit" class="stat-unit">{{ unit }}</span>
    </div>
    <div class="stat-foot">
      <span v-if="deltaText" class="stat-delta" :class="`is-${deltaTone}`">
        <span class="stat-arrow" aria-hidden="true">{{ delta && delta > 0 ? '↑' : '↓' }}</span>
        {{ deltaText }}
      </span>
      <span v-if="hint" class="stat-hint">{{ hint }}</span>
    </div>
  </div>
</template>

<style scoped>
/* 读数块之间用发丝线分隔，而不是各自包一张卡 */
.stat {
  padding: var(--s-4) 0;
  min-width: 0;
}
.stat-label {
  font-size: var(--fs-xs);
  color: var(--paper-faint);
  letter-spacing: var(--track-wide);
  text-transform: uppercase;
}
.stat-value {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: var(--fs-3xl);
  font-weight: 500;
  letter-spacing: var(--track-display);
  line-height: 1.1;
  margin-top: 6px;
}
.stat-unit {
  font-size: var(--fs-sm);
  color: var(--paper-faint);
  margin-left: 4px;
  letter-spacing: 0;
}
.stat-foot {
  display: flex;
  align-items: baseline;
  gap: var(--s-2);
  min-height: 17px;
  margin-top: 4px;
}
.stat-delta {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
}
.stat-arrow {
  margin-right: 2px;
}
.is-ok {
  color: var(--link);
}
.is-bad {
  color: var(--fault);
}
.stat-hint {
  font-size: var(--fs-xs);
  color: var(--paper-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
