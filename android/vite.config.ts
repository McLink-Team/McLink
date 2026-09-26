import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

/**
 * Android 端的渲染层构建。
 *
 * **这里不是第二套前端**：入口（web/src/main.ts）只是「装一层 window.mclink 适配，
 * 再把 client/src 里那些页面挂进一个移动端外壳」，页面组件、样式与令牌全部来自
 * `../../client/src`。所以这份配置干的事和 client/vite.config.ts 是同一件，
 * 只有三处必要差异：
 *   1. `root` 指到 web/（移动端自己的 index.html），产物进 dist/ 供 Capacitor 打包；
 *   2. 内置主控地址默认就是官方 `https://cnnic.link`（手机上没有"本地开发主控"这回事），
 *      但仍允许 VITE_MCLINK_MASTER 覆盖，方便连测试主控；
 *   3. 把 package.json 的版本号注入成编译期常量 —— Android 拿不到 Electron 的
 *      `app.getVersion()`，版本号只能从构建时带进来（否则外壳底部的版本永远空白）。
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** 与 client/src/lib/api.ts 的 DEV_FALLBACK_MASTER 同形，但默认值换成线上主控 */
const master = (process.env.VITE_MCLINK_MASTER ?? 'https://cnnic.link').trim().replace(/\/+$/, '');

export default defineConfig({
  root: here,
  // Capacitor 用 WebViewLocalServer 从本地资源根加载 index.html，相对路径即可
  base: './',
  plugins: [vue()],
  define: {
    __MCLINK_APP_VERSION__: JSON.stringify(pkg.version),
    'import.meta.env.VITE_MCLINK_MASTER': JSON.stringify(master),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // android/ 是 monorepo 成员，正常能解析；这条别名是为了让「用编辑器打开单个文件」
      // 或不经 pnpm 安装也能构建，不至于因为链接没建好就整包失败
      '@mclink/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Android WebView 版本跨度大（Android 8 起仍是 Chromium 58+）。
    // Capacitor 7 官方要求 Android 6+ / WebView 60+，这里按 Chromium 87 目标降级语法，
    // 免得在新语法上白屏 —— 手机上没法开 devtools，白屏是最难查的一种失败。
    target: 'chrome87',
  },
  server: {
    host: true,
    port: 5175,
    strictPort: true,
  },
});
