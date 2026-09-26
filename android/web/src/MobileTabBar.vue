<script setup lang="ts">
/**
 * Android 底部导航 —— 桌面左栏（AppRail.vue）在窄竖屏上的转置。
 *
 * **同一批去处、同一批图标、同一套选中语言**：图标直接复用 `RailIcon.vue`
 * （自绘 SVG 的唯一事实来源），选中态与桌面逐字一致（`--accent-wash` 底 +
 * `--accent` 图标与文字），文案也是桌面的那四个字。之所以写成一个组件而不是
 * 给 AppRail 加个"横过来"的 CSS 开关：AppRail 的样式是 `scoped` 的（`.rail` 会被
 * 编译成 `.rail[data-v-xxx]`，特异性 0,2,0），外部样式想覆盖它只能靠同特异性拼源码顺序
 * 或 `!important` —— 两种都是"下次改桌面就会坏"的写法。
 *
 * ## 为什么这里是三项，而桌面是四项
 *
 * 桌面左栏是「联机 / 大厅 / 收藏 / 设置」。移动端本轮的范围是
 * 「登录 → 看房间 → 建房 → 拿加入码与联机地址 → 凭码加入 → 看成员」，收藏不在范围内。
 * 而且**收藏的内容本来就在**：「最近进入的房间」是 `RoomShortcuts`，
 * 它被 `CreateJoin.vue` 直接嵌在「联机」那一屏里（第 507 行），
 * 所以再给一个「收藏」标签页只是把同一份列表放在第二个地方。
 *
 * 于是砍掉的是**入口**，不是能力 —— 这也是"不需要的入口直接不出现，
 * 而不是留个死按钮"的具体落法。
 */
import { computed } from 'vue';
import RailIcon, { type RailIconName } from '../../../client/src/components/RailIcon.vue';

/** 移动端的三个去处。类型刻意与桌面的 RailKey 区分开：少了一项，不是同一个集合。 */
export type MobileTab = 'home' | 'plaza' | 'settings';

const props = defineProps<{
  active: MobileTab;
  /** 未登录时「设置」要账号才有内容，置灰但**不隐藏**（和桌面一样：看得见去处） */
  signedIn?: boolean;
  /** 房间在时，「联机」那一项带一个状态点 —— 返回房间的入口就是它 */
  inRoom?: boolean;
  online?: boolean;
}>();

const emit = defineEmits<{ select: [MobileTab] }>();

const items: Array<{ key: MobileTab; label: string; icon: RailIconName }> = [
  { key: 'home', label: '联机', icon: 'home' },
  { key: 'plaza', label: '大厅', icon: 'plaza' },
  { key: 'settings', label: '设置', icon: 'settings' },
];

/** 未登录时这一项没有内容可给（设置里大半要账号） */
const locked = (key: MobileTab): boolean => props.signedIn === false && key === 'settings';

const dotClass = computed(() => (props.online ? 'dot-ok' : 'dot-warn'));
</script>

<template>
  <nav class="mobile-tabbar" aria-label="主导航">
    <button
      v-for="item in items"
      :key="item.key"
      class="mobile-tab"
      :class="{ active: active === item.key }"
      type="button"
      :disabled="locked(item.key)"
      :title="locked(item.key) ? `${item.label}：登录后可用` : item.label"
      :aria-current="active === item.key ? 'page' : undefined"
      @click="emit('select', item.key)"
    >
      <RailIcon :name="item.icon" />
      <span class="mobile-tab-label">{{ item.label }}</span>
      <!-- 状态点：房间在时挂在「联机」上，与桌面 .rail-dot 同形同色 -->
      <span v-if="item.key === 'home' && inRoom" class="mobile-tab-dot" :class="dotClass" />
    </button>
  </nav>
</template>

<!--
  样式全部在 android/web/src/mobile-shell.css 里（非 scoped）。
  理由：底栏与 dock、内容区三者共享 --tabbar-h / --safe-bottom 这些变量，
  分成两个文件会让人改一处忘一处。这里不留 <style> 块是**刻意的**。
-->
