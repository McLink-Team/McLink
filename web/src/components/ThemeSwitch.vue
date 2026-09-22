<script setup lang="ts">
/**
 * 亮/暗配色开关（跟随系统 / 亮色 / 暗色）。
 *
 * 为什么要有它：之前网页端只有「跟随系统」——系统是暗色的人想看亮色就没辙，
 * 而客户端早就有这个开关了，两个前端的说法不一致。
 *
 * 实现要点：
 *   · 偏好存 localStorage['mclink.theme']，与客户端、与 index.html 的无闪烁脚本同一把钥匙；
 *   · 真正改主题的是 `setThemeChoice()`（在 shared 里），它负责写盘 + 立刻改
 *     `<html data-theme>` + 按需重新订阅系统变化 —— 组件不碰 DOM 细节；
 *   · ?theme=light|dark 优先级最高（检测器与本地核对用），此时开关会禁用并说明原因，
 *     免得用户以为点了没反应。
 */
import { computed, onMounted, ref } from 'vue';
import { forcedTheme, setThemeChoice, themeChoice, type ThemeChoice } from '@mclink/shared';

const OPTIONS: ReadonlyArray<{ value: ThemeChoice; label: string; title: string }> = [
  { value: 'auto', label: '自动', title: '跟随系统配色' },
  { value: 'light', label: '亮色', title: '始终使用亮色' },
  { value: 'dark', label: '暗色', title: '始终使用暗色' },
];

const choice = ref<ThemeChoice>('auto');
const locked = ref(false);

onMounted(() => {
  choice.value = themeChoice();
  locked.value = forcedTheme() !== null;
});

const note = computed(() =>
  locked.value ? '当前由 URL 的 ?theme= 参数强制指定，改这里不会生效。' : '',
);

function pick(next: ThemeChoice): void {
  if (locked.value) return;
  choice.value = next;
  setThemeChoice(next);
}
</script>

<template>
  <!--
    强制模式下不渲染三个禁用按钮，而是换成一句说明。
    原因：禁用样式最自然的写法是 opacity: 0.5，但那会把文字压成 ~1.1:1 的像素对比度，
    检测器直接报 low-contrast（实测 light/dark 各 9 条），而且"灰掉的按钮"本身也不是好提示。
    换成一个静态标签，既没有对比度问题，也把"为什么点不了"说清楚了。
  -->
  <span v-if="locked" class="theme-locked" :title="note">配色跟随链接参数</span>
  <div v-else class="theme-switch" role="group" aria-label="配色模式">
    <button
      v-for="opt in OPTIONS"
      :key="opt.value"
      class="theme-opt"
      type="button"
      :class="{ active: choice === opt.value }"
      :aria-pressed="choice === opt.value"
      :title="opt.title"
      @click="pick(opt.value)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>

<style scoped>
/* 三段式开关：与客户端设置页那套观感一致（小、安静、不抢主操作） */
.theme-switch {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--rule);
  border-radius: var(--r-sm);
  background: var(--ink-850);
}
.theme-opt {
  padding: 3px 9px;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--paper-faint);
  font-size: var(--fs-xs);
  line-height: 1.5;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.theme-opt:hover:not(:disabled) {
  color: var(--paper);
}
.theme-opt.active {
  background: var(--ink-700);
  color: var(--paper);
}
/* 强制模式下的说明标签：不用 opacity 变淡（会掉对比度），改用更弱的文字色 + 常规字号 */
.theme-locked {
  font-size: var(--fs-xs);
  color: var(--paper-faint);
  white-space: nowrap;
}
</style>
