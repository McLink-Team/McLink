<script setup lang="ts">
/**
 * 产品印记：一个等距视角的方块。
 *
 * 为什么是这个形状：这款产品做的事情就是「给一个方块世界拉一条链路」，
 * 而方块本身就是这个世界最小的单位。所以印记是一个立方体，但**不是**贴图方块：
 *   · 整体是发丝线画的等距立方体（六边形轮廓 + 中间那个 Y），用 currentColor；
 *   · 只有**顶面**是实心的琥珀色 —— 全局唯一强调色只落在这一面上，
 *     于是「哪一面亮着」成了这个标志的语义：链路通了。
 *   · 顶面里三个由小到大的圆点，是信号刻度（也是「房间里的人」）：
 *     小 → 大，是从一个节点长到一张网。
 *
 * 全部顺手画在 48×48 的网格里，缩到 13px（标题栏）或放到 76px（主屏）都不糊。
 * 不用渐变、不用发光、不引外部图片 —— 只有 currentColor 与两个颜色令牌。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 16 });
</script>

<template>
  <svg
    class="brand-mark"
    :style="{ width: `${size}px`, height: `${size}px` }"
    viewBox="0 0 48 48"
    aria-hidden="true"
    focusable="false"
  >
    <!-- 顶面：唯一实心面 -->
    <polygon class="bm-lit" points="24,24 36.99,16.5 24,9 11.01,16.5" />
    <!-- 顶面上的信号刻度：小 → 大 -->
    <g class="bm-pips">
      <circle cx="20.4" cy="18.6" r="1" />
      <circle cx="23.4" cy="16.9" r="1.35" />
      <circle cx="26.8" cy="14.9" r="1.75" />
    </g>
    <!-- 立体轮廓与那个 Y -->
    <polygon class="bm-wire" points="24,9 36.99,16.5 36.99,31.5 24,39 11.01,31.5 11.01,16.5" />
    <path class="bm-wire" d="M24 24 36.99 16.5 M24 24 11.01 16.5 M24 24 V39" />
  </svg>
</template>

<style scoped>
.brand-mark {
  display: block;
  flex: none;
  color: var(--paper-2);
}
.bm-lit {
  fill: var(--signal);
}
.bm-pips circle {
  fill: var(--on-signal);
}
.bm-wire {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linejoin: round;
  stroke-linecap: round;
}
</style>
