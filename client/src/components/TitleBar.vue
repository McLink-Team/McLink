<script setup lang="ts">
/**
 * 自绘标题栏（新外壳版）。
 *
 * 无边框窗口下这条栏承担三件事：拖动区域、窗口控制、以及"现在通不通"那一行状态。
 * 「暖纸台」世界里它**不是一条深色横带**：底色与页面同为 --ground，靠留白与
 * 右侧的窗口按钮区分层次 —— 参考稿也是这么处理的（顶部没有分隔线）。
 *
 * 关闭按钮仍然是**收进托盘**而不是退出（行为由偏好决定，见 SettingsPage 的
 * 「关闭窗口时」）：退出会把正在跑的房间网络一起关掉，误点代价太大。
 *
 * macOS 上这条栏**只留下拖动区与状态文字**，三个自绘按钮交给系统红黄绿：
 *   · 位置在窗口左上角，而那一片现在是左侧图标栏（AppRail 顶部已经留出空白）；
 *   · 系统按钮的行为（⌥ 绿灯=缩放、绿灯=全屏、VoiceOver）自绘模仿不来；
 *   · 关窗语义在 mac 上本来就不等于退出，用系统按钮表达最不容易误解。
 * 状态文字仍然留在右侧 —— 那是"现在通不通"，与平台无关，必须一眼看得到。
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { isMac } from '../lib/platform.ts';

const props = defineProps<{
  /** 当前页面名，显示在左侧（参考稿那里放的是应用名） */
  title: string;
  /** 连接状态，决定状态点的语义色 */
  state: 'stopped' | 'starting' | 'running' | 'error';
  /** 状态文案 */
  label: string;
}>();

const maximized = ref(false);
let offMaximized: (() => void) | null = null;

/** 状态点：正常/连接中都是绿的（用户要求提示灯全绿），只有真出错才红 */
const toneClass = () =>
  props.state === 'error' ? 'led-fault' : props.state === 'stopped' ? '' : 'led-ok';

async function minimize(): Promise<void> {
  await window.mclink.win.minimize();
}
async function toggleMaximize(): Promise<void> {
  maximized.value = (await window.mclink.win.toggleMaximize()) ?? false;
}
async function close(): Promise<void> {
  await window.mclink.win.close();
}

/**
 * 双击空白处切换最大化（系统的习惯动作，去掉原生标题栏后要自己补回来）。
 *
 * macOS 上**不要**自己处理：那里的拖动区由系统接管双击，
 * 行为跟随「系统设置 → 桌面与程序坞 → 双击标题栏时」的偏好（缩放/最小化），
 * 我们再补一次 toggleMaximize 就会和系统动作打架（点一下动两次）。
 */
function onDoubleClick(event: MouseEvent): void {
  if (isMac) return;
  const target = event.target as HTMLElement;
  if (target.closest('button')) return;
  void toggleMaximize();
}

onMounted(async () => {
  if (isMac) return; // 没有自绘按钮，就不必问最大化状态（也就不会多一次 IPC）
  maximized.value = (await window.mclink.win.isMaximized()) ?? false;
  offMaximized = window.mclink.win.onMaximized((flag) => {
    maximized.value = flag;
  });
});
onUnmounted(() => offMaximized?.());
</script>

<template>
  <header class="titlebar" :class="{ 'titlebar-mac': isMac }" @dblclick="onDoubleClick">
    <h1 class="tb-title">{{ title }}</h1>

    <div class="tb-status" :title="label">
      <span class="led" :class="toneClass()" />
      <span class="tb-status-text">{{ label }}</span>
    </div>

    <!-- macOS：窗口控制由系统红黄绿担任，这里一个按钮都不画 -->
    <div v-if="!isMac" class="tb-controls">
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
      <button
        class="tb-btn tb-close"
        type="button"
        title="收进托盘（退出请用托盘菜单）"
        aria-label="收进托盘"
        @click="close"
      >
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
  height: 52px;
  flex: none;
  padding-left: var(--s-5);
  background: var(--ground);
  -webkit-app-region: drag;
  user-select: none;
}
/* 按钮必须显式取消拖动，否则点不动 */
.titlebar button {
  -webkit-app-region: no-drag;
}

/*
 * macOS：右侧没有自绘按钮，状态文字就直接贴到窗口边了 ——
 * 用与左侧同一个内边距收边（Windows 侧那 6px 是按钮容器自带的）。
 * 高度不变（52px）：状态文字与系统红黄绿在视觉上仍是一条水平线。
 */
.titlebar-mac {
  padding-right: var(--s-5);
}

.tb-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--fs-lg);
  font-weight: 600;
  letter-spacing: var(--track-tight);
  color: var(--ink);
}

.tb-status {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--ink-2);
  min-width: 0;
}
.tb-status-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 300px;
}

.tb-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 6px;
}
/* 窗口按钮：40px 见方的命中区，图标 1.1 描边；hover 用一层浅底而不是改边框 */
.tb-btn {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
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
  background: color-mix(in srgb, var(--surface) 60%, transparent);
  color: var(--ink);
}
.tb-close:hover {
  background: var(--fault);
  color: #fff;
}
</style>
