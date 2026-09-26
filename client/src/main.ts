import { createApp } from 'vue';
import { applyAutoTheme } from '@mclink/shared';
import App from './App.vue';
import './styles.css';
// 「暖纸台」世界：覆盖共享令牌的取值（只作用于客户端，官网/控制台不受影响）
import './theme-warm.css';

/*
 * 亮/暗跟随系统。
 *
 * 放在挂载之前：Electron 的窗口是 `show: false` + `ready-to-show` 才显示的，
 * 所以首帧不可见、不会闪 —— 也就不需要在 index.html 里塞内联脚本
 * （那个 CSP 不允许，见 client/index.html 的 script-src）。
 */
applyAutoTheme();

createApp(App).mount('#app');
