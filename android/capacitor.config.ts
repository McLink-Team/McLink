import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 配置 —— Android 端的外壳。
 *
 * ## 为什么用 Capacitor 而不是自己写一个 WebView Activity
 *
 * 两条路都能跑，差别在下一次改动：
 *   · 自己写 Activity：现在省一个依赖，但资产同步、返回键、权限回调、
 *     配置变更（旋转/深色模式）都要自己处理，而且里程碑 2 要接 VpnService 时
 *     仍然得自己造一套 JS↔原生 的桥；
 *   · Capacitor：`webDir` 一填就完成了资产打包，返回键/生命周期由它兜底，
 *     而里程碑 2 的 VpnService 正好就是一个 Capacitor 插件（`registerPlugin`）——
 *     桥是我们本来就要建的东西，不是为 Capacitor 多付的成本。
 *
 * ## 关键字段
 *
 * - `webDir: 'dist'` —— vite 的产物目录（见 vite.config.ts 的 build.outDir）。
 *   `npx cap sync android` 会把它整个拷进 `android/app/src/main/assets/public/`。
 * - `android.allowMixedContent: false` —— 主控是 https（cnnic.link），
 *   没有理由放开明文混合内容；放开只会让中间人有机会往下塞 http 资源。
 * - `android.webContentsDebuggingEnabled` —— 默认只在 debug 构建里开。
 *   手机上没有 devtools 就等于没有眼睛，debug 包必须留着它（用 chrome://inspect 连）。
 */
const config: CapacitorConfig = {
  appId: 'link.cnnic.mclink',
  appName: 'McLink',
  webDir: 'dist',

  android: {
    allowMixedContent: false,
    // 里程碑 1 没有任何原生插件，先不开 capture/缩放之类的额外开关
    webContentsDebuggingEnabled: true,
  },

  /*
   * 不做 server.url 远程加载。
   *
   * 那会让 App 变成一个"壳里打开网页"的浏览器，资产不随包走 ——
   * 断网、官网改版、CDN 出问题都会让 App 白屏，而这本来是一个本地 App。
   * 里程碑 1 的包必须自带全部前端资产（vite 产物进 assets/public）。
   */
};

export default config;
