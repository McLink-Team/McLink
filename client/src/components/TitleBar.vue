<script setup lang="ts">
/**
 * 自绘标题栏。
 *
 * 窗口是无边框的（frame: false），所以这条栏同时承担三件事：
 *   1. 拖动区域（-webkit-app-region: drag，按钮上要显式关掉）
 *   2. 连接状态（一个信号灯 + 一行字，玩家最关心"现在通不通"）
 *   3. 窗口控制（最小化 / 最大化-还原 / 关闭），图标是手绘 SVG，不用 Unicode 符号
 *
 * 关闭按钮的行为是**收进托盘**而不是退出：退出会把正在跑的房间网络一起关掉，
 * 误点代价太大；真正的退出放在托盘菜单里。
 */
import { onMounted, onUnmounted, ref } from 'vue';

const props = defineProps<{
  /** 连接状态，决定信号灯的语义色 */
  state: 'stopped' | 'starting' | 'running' | 'error';
  /** 状态文案 */
  label: string;
}>();

const maximized = ref(false);
let offMaximized: (() => void) | null = null;

const toneClass = () =>
  props.state === 'running'
    ? 'led-ok led-live'
    : props.state === 'starting'
      ? 'led-signal'
      : props.state === 'error'
        ? 'led-danger'
        : '';

async function minimize(): Promise<void> {
  await window.mclink.win.minimize();
}
async function toggleMaximize(): Promise<void> {
  maximized.value = (await window.mclink.win.toggleMaximize()) ?? false;
}
async function close(): Promise<void> {
  await window.mclink.win.close();
}

/** 双击空白处切换最大化（系统的习惯动作，去掉原生标题栏后要自己补回来） */
function onDoubleClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  if (target.closest('button')) return;
  void toggleMaximize();
}

onMounted(async () => {
  maximized.value = (await window.mclink.win.isMaximized()) ?? false;
  offMaximized = window.mclink.win.onMaximized((flag) => {
    maximized.value = flag;
  });
});
onUnmounted(() => offMaximized?.());
</script>

<template>
  <header class="titlebar" @dblclick="onDoubleClick">
    <div class="tb-brand">
      <span class="tb-mark" aria-hidden="true" />
      <span class="tb-name">mclink</span>
    </div>

    <div class="tb-status" :title="label">
      <span class="led" :class="toneClass()" />
      <span class="tb-status-text">{{ label }}</span>
    </div>

    <div class="tb-controls">
      <button class="tb-btn" type="button" title="最小化" aria-label="最小化" @click="minimize">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7" /></svg>
      </button>
      <button
        class="tb-btn"
        type="button"
        :title="maximized ? '还原' : '最大化'"
        :aria-label="maximized ? '还原' : '最大化'"
        @click="toggleMaximize"
      >
        <svg v-if="!maximized" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
        </svg>
        <svg v-else viewBox="0 0 12 12" aria-hidden="true">
          <rect x="2.5" y="4" width="5.5" height="5.5" rx="1" />
          <path d="M4.5 4V3.2a1 1 0 0 1 1-1h3.3a1 1 0 0 1 1 1v3.3a1 1 0 0 1-1 1H8" />
        </svg>
      </button>
      <button class="tb-btn tb-close" type="button" title="收进托盘（退出请用托盘菜单）" aria-label="收进托盘" @click="close">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6" /></svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  height: 36px;
  flex: none;
  padding-left: var(--s-3);
  background: var(--ink-950);
  border-bottom: 1px solid var(--rule);
  -webkit-app-region: drag;
  user-select: none;
}
/* 按钮必须显式取消拖动，否则点不动 */
.titlebar button {
  -webkit-app-region: no-drag;
}

.tb-brand {
  display: flex;
  align-items: center;
  gap: 7px;
}
.tb-mark {
  width: 13px;
  height: 13px;
  background: var(--signal);
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
}
.tb-name {
  font-family: var(--font-display);
  font-size: var(--fs-sm);
  font-weight: 600;
  letter-spacing: var(--track-display);
  color: var(--paper);
}

.tb-status {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-left: auto;
  padding-right: var(--s-2);
  font-size: var(--fs-xs);
  color: var(--paper-dim);
  min-width: 0;
}
.tb-status-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 190px;
}

.tb-controls {
  display: flex;
  align-items: stretch;
  align-self: stretch;
}
/* 窗口按钮：28px 见方的命中区，图标 1px 描边，风格与全站一致 */
.tb-btn {
  width: 34px;
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--paper-dim);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.tb-btn svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.1;
  stroke-linecap: round;
}
.tb-btn:hover {
  background: var(--surface-hair-strong);
  color: var(--paper);
}
.tb-close:hover {
  background: var(--fault);
  color: var(--on-signal);
}
</style>
