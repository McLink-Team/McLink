<script setup lang="ts">
/** 404：保持克制，只提供回首页与下载页两个出口。 */
import { RouterLink } from 'vue-router';
</script>

<template>
  <div class="nf aurora">
    <div class="container nf-inner">
      <div class="nf-code">404</div>
      <h1>这个房间不存在</h1>
      <p class="muted">页面可能已被移动、关闭，或者链接里的加入码有笔误。</p>
      <div class="nf-actions">
        <RouterLink class="btn btn-primary" to="/">返回首页</RouterLink>
        <RouterLink class="btn" to="/download">下载客户端</RouterLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.nf {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: var(--s-6) var(--s-4);
  text-align: center;
}
.nf-inner {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--s-3);
  max-width: 480px;
}
.nf-code {
  font-family: var(--font-mono);
  font-size: var(--fs-4xl);
  font-weight: 700;
  line-height: 1;
  background: var(--grad-brand);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.nf h1 {
  font-size: var(--fs-2xl);
}
.nf-actions {
  display: flex;
  gap: var(--s-3);
  margin-top: var(--s-3);
  flex-wrap: wrap;
  justify-content: center;
}
</style>
