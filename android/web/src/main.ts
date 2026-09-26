/**
 * Android 端的渲染层入口。
 *
 * 和 `client/src/main.ts`（Electron 入口）是**同一个套路**，只有两处差别：
 *   1. 先装 Android 版的 `window.mclink`（Electron 那份由 preload.cjs 提供）；
 *   2. 挂的是移动端外壳 MobileApp，而不是桌面外壳 App。
 * 样式与令牌的 import 顺序与桌面完全一致（共享令牌 → 暖纸台世界 → 外壳自身），
 * 移动端外壳的覆盖放在**最后**，因为它是唯一允许盖住世界层的东西。
 */
// ⚠️ 必须是第一个 import：它保证 window.mclink 在整条依赖图求值前就位。
// 也**必须**排在样式之前 —— Vite 会按 import 顺序把 CSS 注进文档，
// 顺序错了移动端覆盖就会被世界层盖回去（表现是底栏变回竖栏）。
import './install-bridge.ts';

import { createApp } from 'vue';
import { applyAutoTheme } from '@mclink/shared';

// 1. 共享令牌（packages/shared/src/design/tokens.css，由 styles.css @import 进来）+ 组件样式
import '../../../client/src/styles.css';
// 2. 「暖纸台」世界：覆盖共享令牌的取值（与桌面客户端同一份文件，不另起一套）
import '../../../client/src/theme-warm.css';
// 3. 移动端外壳：底栏、单列、安全区、触控尺寸（只改布局，不定义任何颜色）
import './mobile-shell.css';

import MobileApp from './MobileApp.vue';

/*
 * 亮/暗跟随系统。
 *
 * 放在挂载之前：与桌面同一个理由（见 client/src/main.ts）—— 首帧就要是对的主题，
 * 晚一帧会闪。Android WebView 的 prefers-color-scheme 跟随系统深色模式。
 */
applyAutoTheme();

/**
 * 把 `--ground` 的实际取值喂给 <meta name="theme-color">。
 *
 * 为什么不在 index.html 里直接写 `content="#e6ded6"`：那是一个**硬编码色值**，
 * 正是 DESIGN.md 禁止的东西 —— 换世界时它不会跟着变，而且没人会想起来改它。
 * 这里从计算样式里读，令牌改了状态栏自动跟着改，也不用关心亮/暗。
 */
function syncThemeColor(): void {
  const ground = getComputedStyle(document.documentElement).getPropertyValue('--ground').trim();
  if (ground.length === 0) return;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', ground);
}

syncThemeColor();
createApp(MobileApp).mount('#app');
