<script setup lang="ts">
/**
 * 零依赖迷你折线图。
 * 用于流量趋势：不需要坐标轴交互，只需要一眼看出形态，所以手写 SVG 比引图表库更划算。
 */
import { computed } from 'vue';
import type { TrafficPoint } from '@mclink/shared';

const props = withDefaults(
  defineProps<{
    points: TrafficPoint[];
    /** 取哪个字段画线 */
    field?: 'rxBps' | 'txBps';
    height?: number;
    /** 是否填充面积 */
    area?: boolean;
    color?: string;
    /** 显示两条线（收发对比） */
    compare?: boolean;
  }>(),
  { field: 'rxBps', height: 64, area: true, color: 'var(--brand)', compare: false },
);

const width = 600;

const series = computed(() => props.points.map((p) => Number(p[props.field] ?? 0)));

function pathFor(values: number[]): { line: string; fill: string } {
  if (values.length === 0) return { line: '', fill: '' };
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const scale = (v: number) => props.height - (v / max) * (props.height - 6) - 3;

  let line = '';
  for (let i = 0; i < values.length; i += 1) {
    const x = i * step;
    const y = scale(values[i] ?? 0);
    line += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }
  const fill = `${line}L${width},${props.height}L0,${props.height}Z`;
  return { line, fill };
}

const primary = computed(() => pathFor(series.value));
const secondary = computed(() => (props.compare ? pathFor(props.points.map((p) => Number(p.txBps ?? 0))) : null));

const gradientId = computed(() => `spark-${Math.random().toString(36).slice(2, 9)}`);
const hasData = computed(() => props.points.length > 1);
</script>

<template>
  <div class="spark">
    <svg
      v-if="hasData"
      :viewBox="`0 0 ${width} ${height}`"
      :height="height"
      preserveAspectRatio="none"
      role="img"
      aria-label="流量趋势"
    >
      <defs>
        <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" :stop-color="color" stop-opacity="0.34" />
          <stop offset="100%" :stop-color="color" stop-opacity="0" />
        </linearGradient>
      </defs>
      <path v-if="area" :d="primary.fill" :fill="`url(#${gradientId})`" />
      <path :d="primary.line" fill="none" :stroke="color" stroke-width="1.8" stroke-linejoin="round" />
      <template v-if="secondary">
        <path :d="secondary.line" fill="none" stroke="var(--accent)" stroke-width="1.4" stroke-dasharray="4 3" />
      </template>
    </svg>
    <div v-else class="spark-empty">暂无足够样本</div>
  </div>
</template>

<style scoped>
.spark {
  width: 100%;
}
.spark svg {
  width: 100%;
  display: block;
  overflow: visible;
}
.spark-empty {
  height: 100%;
  min-height: 48px;
  display: grid;
  place-items: center;
  color: var(--text-faint);
  font-size: var(--fs-xs);
  border: 1px dashed var(--border);
  border-radius: var(--r-sm);
}
</style>
