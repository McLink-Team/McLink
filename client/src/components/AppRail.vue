<script setup lang="ts">
/**
 * 左侧图标栏（76px）—— 「暖纸台」世界的导航骨架。
 *
 * 为什么从"底部标签栏"改成"左侧图标栏"：这个世界的参照是一个桌面启动器，
 * 它的第一眼结构就是竖向图标栏 + 右侧一张大牌。横过来之后横向空间才够，
 * 底栏那四个字的空间正好让给"版本 / 系统"这些一直没地方放的实情。
 *
 * 图标是**自绘 SVG**（统一 1.6 描边、22px、currentColor）：craft floor 明确
 * 不许用 emoji 或 Unicode 字形顶替图标系统，客户端也没有图标库依赖。
 */
import { computed } from 'vue';
import BrandMark from './BrandMark.vue';

export type RailKey = 'home' | 'plaza' | 'bookmarks' | 'settings';

const props = defineProps<{
  active: RailKey;
  /** 房间在时，「联机」那一项带一个状态点 —— 返回房间的入口就是它 */
  inRoom?: boolean;
  online?: boolean;
  /** 有新版本时在「设置」上点一个小点：不打扰，但看一眼就知道 */
  updateAvailable?: boolean;
  userName?: string;
}>();

const emit = defineEmits<{ select: [RailKey] }>();

const items: Array<{ key: RailKey; label: string }> = [
  { key: 'home', label: '联机' },
  { key: 'plaza', label: '大厅' },
  { key: 'bookmarks', label: '收藏' },
  { key: 'settings', label: '设置' },
];

/** 头像里那一个字：显示名的首字符（中文取第一个字，英文取首字母） */
const initial = computed(() => (props.userName ?? '').trim().slice(0, 1).toUpperCase() || '·');
</script>

<template>
  <nav class="rail" aria-label="主导航">
    <div class="rail-brand" title="McLink">
      <BrandMark />
    </div>

    <ul class="rail-list">
      <li v-for="item in items" :key="item.key">
        <button
          class="rail-item"
          :class="{ active: active === item.key }"
          type="button"
          :aria-current="active === item.key ? 'page' : undefined"
          @click="emit('select', item.key)"
        >
          <span class="rail-icon" aria-hidden="true">
            <!-- 联机：手柄 -->
            <svg v-if="item.key === 'home'" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path
                d="M7.5 8h9a4.5 4.5 0 0 1 4.4 3.6l.7 4a2.6 2.6 0 0 1-4.6 2.1l-1-1.3a2 2 0 0 0-1.6-.8h-4.8a2 2 0 0 0-1.6.8l-1 1.3a2.6 2.6 0 0 1-4.6-2.1l.7-4A4.5 4.5 0 0 1 7.5 8Z"
                stroke-linejoin="round"
              />
              <path d="M8.5 12.2v2.4M7.3 13.4h2.4" stroke-linecap="round" />
              <circle cx="15.4" cy="13.4" r="1.05" fill="currentColor" stroke="none" />
            </svg>
            <!-- 大厅：网格 -->
            <svg v-else-if="item.key === 'plaza'" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <rect x="3.5" y="3.5" width="7" height="7" rx="2" stroke-linejoin="round" />
              <rect x="13.5" y="3.5" width="7" height="7" rx="2" stroke-linejoin="round" />
              <rect x="3.5" y="13.5" width="7" height="7" rx="2" stroke-linejoin="round" />
              <rect x="13.5" y="13.5" width="7" height="7" rx="2" stroke-linejoin="round" />
            </svg>
            <!-- 收藏：书签 -->
            <svg v-else-if="item.key === 'bookmarks'" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M6.5 4.5h11v15l-5.5-3.8L6.5 19.5v-15Z" stroke-linejoin="round" />
            </svg>
            <!-- 设置：滑杆（原本画的是"齿轮"，实测看起来像一个太阳/亮度图标 —— 认错等于没有图标） -->
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M4 7.5h10M19 7.5h1M4 16.5h4M13 16.5h7" stroke-linecap="round" />
              <circle cx="16.5" cy="7.5" r="2.1" />
              <circle cx="10.5" cy="16.5" r="2.1" />
            </svg>
          </span>
          <span class="rail-label">{{ item.label }}</span>
          <span v-if="item.key === 'home' && inRoom" class="rail-dot" :class="online ? 'dot-ok' : 'dot-warn'" />
          <span v-else-if="item.key === 'settings' && updateAvailable" class="rail-dot dot-accent" />
        </button>
      </li>
    </ul>

    <button class="rail-avatar" type="button" :title="userName || '账户'" @click="emit('select', 'settings')">
      {{ initial }}
    </button>
  </nav>
</template>

<style scoped>
.rail {
  flex: none;
  width: 76px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--s-2);
  padding: 14px 8px 12px;
  background: var(--ground-deep);
}

/* 品牌块：56×56 的白卡 + 一点柔和投影（参考里唯一带投影的固定元素） */
.rail-brand {
  width: 56px;
  height: 56px;
  display: grid;
  place-items: center;
  border-radius: var(--r-md);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.rail-list {
  list-style: none;
  margin: var(--s-2) 0 0;
  padding: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.rail-item {
  position: relative;
  width: 100%;
  min-height: 56px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 7px 2px 6px;
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.rail-item:hover {
  background: color-mix(in srgb, var(--surface) 55%, transparent);
  color: var(--ink);
}
/* 选中态：整块浅色指示底 + 强调色图标与文字。
 * 指示底用 --accent-soft 的 wash（非文字），文字用 --accent（过 AA 的那一档）。 */
.rail-item.active {
  background: var(--accent-wash);
  color: var(--accent);
}

.rail-icon {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
}
.rail-icon svg {
  width: 22px;
  height: 22px;
  stroke-width: 1.6;
}
.rail-label {
  font-size: var(--fs-xs);
  font-weight: 500;
  letter-spacing: 0.02em;
}
.rail-item.active .rail-label {
  font-weight: 650;
}

.rail-dot {
  position: absolute;
  top: 8px;
  right: 12px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.dot-ok {
  background: var(--ok);
}
.dot-warn {
  background: var(--warn);
}
.dot-accent {
  background: var(--accent);
}

.rail-avatar {
  flex: none;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: var(--surface);
  color: var(--ink);
  font-family: var(--font-display);
  font-size: var(--fs-base);
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--shadow-card);
  transition: background var(--dur-fast) var(--ease);
}
.rail-avatar:hover {
  background: var(--surface-3);
}
</style>
