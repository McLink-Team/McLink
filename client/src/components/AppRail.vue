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
 *
 * 图标本身住在 RailIcon.vue —— 因为 Android 端的底部导航用的是**同一批去处**，
 * 路径数据只允许有一份（理由见那个文件的注释）。
 */
import { computed } from 'vue';
import BrandMark from './BrandMark.vue';
import RailIcon from './RailIcon.vue';

export type RailKey = 'home' | 'plaza' | 'bookmarks' | 'settings';

const props = defineProps<{
  active: RailKey;
  /** 是否已登录：未登录时「收藏」「设置」要账号才有内容，置灰但**不隐藏**（看得见去处） */
  signedIn?: boolean;
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

/** 未登录时这两项没有内容可给（收藏要账号、设置里大半要账号） */
const locked = (key: RailKey): boolean =>
  props.signedIn === false && (key === 'bookmarks' || key === 'settings');

/** 头像里那一个字：显示名的首字符（中文取第一个字，英文取首字母） */
const initial = computed(() => (props.userName ?? '').trim().slice(0, 1).toUpperCase() || '·');
</script>

<template>
  <nav class="rail" aria-label="主导航">
    <div class="rail-brand" title="McLink">
      <BrandMark :size="36" />
    </div>

    <ul class="rail-list">
      <li v-for="item in items" :key="item.key">
        <button
          class="rail-item"
          :class="{ active: active === item.key }"
          type="button"
          :disabled="locked(item.key)"
          :title="locked(item.key) ? `${item.label}：登录后可用` : item.label"
          :aria-current="active === item.key ? 'page' : undefined"
          @click="emit('select', item.key)"
        >
          <RailIcon :name="item.key" />
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
  /* 80 = 64（品牌块）+ 左右各 8 的内边距：品牌块是这一栏的视觉锚点，
   * 做小了整条栏会看着没有"头部"（用户实测反馈：原来 56 太小）。 */
  width: 80px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--s-2);
  padding: 14px 8px 12px;
  background: var(--ground-deep);
}

/* 品牌块：64×64 的白卡 + 一点柔和投影（参考里唯一带投影的固定元素） */
.rail-brand {
  width: 64px;
  height: 64px;
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
.rail-item:hover:not(:disabled) {
  background: color-mix(in srgb, var(--surface) 55%, transparent);
  color: var(--ink);
}
/* 未登录时锁住的两项：看得见去处，但灰掉 —— 比藏起来更好懂 */
.rail-item:disabled {
  color: var(--ink-faint);
  cursor: not-allowed;
}
.rail-item:disabled .rail-label {
  opacity: 0.7;
}
/* 选中态：整块浅色指示底 + 强调色图标与文字。
 * 指示底用 --accent-soft 的 wash（非文字），文字用 --accent（过 AA 的那一档）。 */
.rail-item.active {
  background: var(--accent-wash);
  color: var(--accent);
}

/* 图标的盒子与描边规则已随 RailIcon.vue 一起搬走（桌面与手机共用一份）。 */
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
  background: var(--led-ok);
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
