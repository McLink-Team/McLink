import { createApp } from 'vue';
import { applyAutoTheme } from '@mclink/shared';
import App from './App.vue';
import { router } from './router.ts';
import './styles/base.css';

/*
 * 亮/暗跟随系统。
 * index.html 里已经内联了一段同样的逻辑用于"首屏不闪"；这里接上系统切换的监听
 * （以及 ?theme= 强制模式的判断），所以两处逻辑要保持一致。
 */
applyAutoTheme();

createApp(App).use(router).mount('#app');
