<script setup lang="ts">
/**
 * 印记 + 品牌字 + 一行副标题。主屏与登录屏共用同一套锁排，
 * 免得两个入口长得不一样（那是玩家一眼就能看出来的不一致）。
 */
import BrandMark from './BrandMark.vue';

withDefaults(defineProps<{ mark?: number }>(), { mark: 76 });
</script>

<template>
  <div class="lockup">
    <BrandMark :size="mark" class="lockup-mark" />
    <div class="lockup-word">McLink</div>
    <p class="lockup-sub"><slot /></p>
  </div>
</template>

<style scoped>
.lockup {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 2px;
}
.lockup-mark {
  margin-bottom: var(--s-3);
}
.lockup-word {
  font-family: var(--font-display);
  font-size: var(--fs-3xl);
  font-weight: 600;
  letter-spacing: var(--track-display);
  line-height: var(--lh-tight);
  color: var(--paper);
}
.lockup-sub {
  margin: 6px 0 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-snug);
  color: var(--paper-dim);
  max-width: 26ch;
  overflow-wrap: anywhere;
}
</style>
