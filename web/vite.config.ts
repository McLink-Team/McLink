import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

/**
 * 前端构建产物直接输出到 server/public，
 * 这样主控一个进程就能同时提供 API、控制台与落地页（Debian 上只需一个 systemd 服务）。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../server/public', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.MCLINK_MASTER ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/ws': {
        target: process.env.MCLINK_MASTER ?? 'http://127.0.0.1:8787',
        ws: true,
      },
      '/downloads': {
        target: process.env.MCLINK_MASTER ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
