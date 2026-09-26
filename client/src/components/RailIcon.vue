<script setup lang="ts">
/**
 * 导航图标（自绘 SVG，统一 24 视框 / 1.6 描边 / currentColor）。
 *
 * 为什么单独抽成一个组件：桌面左栏（AppRail，竖排贴着左边）和 Android 底部导航
 * （android/web/src/MobileTabBar.vue，横排贴着底边）用的是**同一批去处**。
 * 图标路径留成两份拷贝，迟早会出现「桌面改了、手机没改」的漂移，
 * 而 craft floor 只允许自绘 SVG（不许 emoji / Unicode 字形顶替、也没有图标库依赖）——
 * 那么这份自绘的**唯一事实来源**就必须有地方放，这里就是那个地方。
 *
 * 尺寸走 `--rail-icon-size` 变量（默认 22px）：桌面左栏要 22，手机底栏通常要略大一点，
 * 但两边的**路径数据与描边粗细**必须一模一样，差别只允许是尺寸。
 */
export type RailIconName = 'home' | 'plaza' | 'bookmarks' | 'settings';

defineProps<{ name: RailIconName }>();
</script>

<template>
  <span class="rail-icon" aria-hidden="true">
    <!-- 联机：手柄 -->
    <svg v-if="name === 'home'" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path
        d="M7.5 8h9a4.5 4.5 0 0 1 4.4 3.6l.7 4a2.6 2.6 0 0 1-4.6 2.1l-1-1.3a2 2 0 0 0-1.6-.8h-4.8a2 2 0 0 0-1.6.8l-1 1.3a2.6 2.6 0 0 1-4.6-2.1l.7-4A4.5 4.5 0 0 1 7.5 8Z"
        stroke-linejoin="round"
      />
      <path d="M8.5 12.2v2.4M7.3 13.4h2.4" stroke-linecap="round" />
      <circle cx="15.4" cy="13.4" r="1.05" fill="currentColor" stroke="none" />
    </svg>
    <!-- 大厅：网格 -->
    <svg v-else-if="name === 'plaza'" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" stroke-linejoin="round" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2" stroke-linejoin="round" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" stroke-linejoin="round" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" stroke-linejoin="round" />
    </svg>
    <!-- 收藏：书签 -->
    <svg v-else-if="name === 'bookmarks'" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M6.5 4.5h11v15l-5.5-3.8L6.5 19.5v-15Z" stroke-linejoin="round" />
    </svg>
    <!-- 设置：滑杆（原本画的是"齿轮"，实测看起来像一个太阳/亮度图标 —— 认错等于没有图标） -->
    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M4 7.5h10M19 7.5h1M4 16.5h4M13 16.5h7" stroke-linecap="round" />
      <circle cx="16.5" cy="7.5" r="2.1" />
      <circle cx="10.5" cy="16.5" r="2.1" />
    </svg>
  </span>
</template>

<style scoped>
.rail-icon {
  display: grid;
  place-items: center;
  width: var(--rail-icon-size, 22px);
  height: var(--rail-icon-size, 22px);
}
.rail-icon svg {
  width: 100%;
  height: 100%;
  stroke-width: 1.6;
}
</style>
