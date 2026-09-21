<script setup lang="ts">
import { dismissToast, toasts } from '../lib/toast.ts';
</script>

<template>
  <div class="toast-host" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        :class="`toast-${t.level}`"
        @click="dismissToast(t.id)"
      >
        <span class="toast-dot" />
        <span class="toast-msg">{{ t.message }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  right: var(--s-5);
  bottom: var(--s-5);
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  pointer-events: none;
  max-width: min(420px, calc(100vw - 32px));
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: var(--s-3);
  padding: 11px var(--s-4);
  border-radius: var(--r-md);
  background: rgba(12, 18, 36, 0.96);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-lg);
  cursor: pointer;
  font-size: var(--fs-sm);
  line-height: 1.5;
  backdrop-filter: blur(12px);
}
.toast-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 6px;
  flex: none;
  background: var(--info);
}
.toast-ok .toast-dot {
  background: var(--ok);
}
.toast-warn .toast-dot {
  background: var(--warn);
}
.toast-error .toast-dot {
  background: var(--danger);
}
.toast-msg {
  min-width: 0;
  word-break: break-word;
}

.toast-enter-active,
.toast-leave-active {
  transition: all var(--dur) var(--ease);
}
.toast-enter-from {
  opacity: 0;
  transform: translateY(10px) scale(0.98);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(20px);
}
</style>
