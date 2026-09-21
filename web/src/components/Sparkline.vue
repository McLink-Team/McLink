<script setup lang="ts">
/**
 * 流量走势 —— 当作**仪器迹线**来画，而不是"软阴影 sparkline"。
 *
 * 与旧实现的区别（这几处正是 AI 味最重的地方）：
 *   · 去掉了渐变填充色块：那是装饰，不是数据；承托迹线的是一条基线。
 *   · 加了一条 1px 基线（真正的图表都有 0 轴）。
 *   · 末端加一个实心点标记"当前值"位置，读数与图形互相指认。
 *   · 颜色只用于区分收/发两条迹线，不参与"美化"。
 */
import { computed } from 'vue';
import type { TrafficPoint } from '@mclink/shared';

const props = withDefaults(
  defineProps<{
    points: TrafficPoint[];
    field?: 'rxBps' | 'txBps';
    height?: number;
    /** 是否同时画收/发两条迹线 */
    compare?: boolean;
    /** 迹线颜色；默认取琥珀 */
    color?: string;
    /** 对比迹线颜色；默认取中性蓝灰 */
    compareColor?: string;
  }>(),
  {
    field: 'rxBps',
    height: 62,
    compare: false,
    color: 'var(--signal)',
    compareColor: 'var(--sky)',
  },
);

const width = 600;
/** 留出右侧空间给"当前值"圆点，避免它被裁掉 */
const padRight = 6;

const rxValues = computed(() => props.points.map((p) => Number(p[props.field] ?? 0)));
const txValues = computed(() => props.points.map((p) => Number(p.txBps ?? 0)));

const hasData = computed(() => props.points.length > 1);

function geometry(values: number[], max: number): { line: string; lastX: number; lastY: number } {
  const usable = props.height - 8;
  const step = values.length > 1 ? (width - padRight) / (values.length - 1) : width;
  const scale = (v: number) => props.height - 4 - (v / max) * usable;
  let line = '';
  let lastX = 0;
  let lastY = props.height;
  for (let i = 0; i < values.length; i += 1) {
    const x = i * step;
    const y = scale(values[i] ?? 0);
    line += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    lastX = x;
    lastY = y;
  }
  return { line, lastX, lastY };
}

const maxValue = computed(() => Math.max(...rxValues.value, ...(props.compare ? txValues.value : [0]), 1));

const primary = computed(() => geometry(rxValues.value, maxValue.value));
const secondary = computed(() =>
  props.compare ? geometry(txValues.value, maxValue.value) : null,
);

const peakLabel = computed(() => {
  const v = maxValue.value;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} Gbps`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} Mbps`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)} kbps`;
  return `${v.toFixed(0)} bps`;
});
</script>

<template>
  <figure class="trace">
    <svg
      v-if="hasData"
      :viewBox="`0 0 ${width} ${height}`"
      :height="height"
      preserveAspectRatio="none"
      role="img"
      :aria-label="`流量走势，峰值 ${peakLabel}`"
    >
      <!-- 0 轴基线：让迹线有落地感，而不是浮在空处 -->
      <line :x1="0" :y1="height - 3" :x2="width" :y2="height - 3" stroke="var(--rule)" stroke-width="1" />

      <path
        v-if="secondary"
        :d="secondary.line"
        fill="none"
        :stroke="compareColor"
        stroke-width="1.25"
        stroke-dasharray="3 3"
        vector-effect="non-scaling-stroke"
      />
      <path
        :d="primary.line"
        fill="none"
        :stroke="color"
        stroke-width="1.5"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
      <!-- 当前值标记 -->
      <circle :cx="primary.lastX" :cy="primary.lastY" r="2.5" :fill="color" />
    </svg>

    <div v-else class="trace-empty faint">暂无足够样本</div>

    <figcaption v-if="hasData" class="trace-cap">
      <span class="faint">峰值 {{ peakLabel }}</span>
      <span v-if="compare" class="trace-legend">
        <span class="trace-key" :style="{ background: color }" />收
        <span class="trace-key dashed" :style="{ borderColor: compareColor }" />发
      </span>
    </figcaption>
  </figure>
</template>

<style scoped>
.trace {
  margin: 0;
  width: 100%;
}
.trace svg {
  width: 100%;
  display: block;
  overflow: visible;
}
.trace-empty {
  height: 100%;
  min-height: 48px;
  display: grid;
  place-items: center;
  font-size: var(--fs-xs);
  border: 1px dashed var(--rule);
  border-radius: var(--r-xs);
}
.trace-cap {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  margin-top: 6px;
  font-size: var(--fs-xs);
}
.trace-legend {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--paper-faint);
}
.trace-key {
  display: inline-block;
  width: 14px;
  height: 0;
  border-top: 1.5px solid;
}
.trace-key.dashed {
  border-top-style: dashed;
}
</style>
