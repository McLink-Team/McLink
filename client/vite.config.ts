import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

/**
 * 只构建渲染进程。主进程与 preload 是纯 CommonJS，不需要打包。
 * base 用 './' 以便 Electron 以 file:// 加载 dist/index.html。
 */
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
