#!/usr/bin/env node
/**
 * 客户端开发模式：先起 Vite 开发服务器，再启动 Electron 指向它。
 * 这样改渲染层代码可以热更新，改主进程代码需要重启本命令。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(HERE, '..');
const DEV_URL = process.env.MCLINK_CLIENT_DEV_URL ?? 'http://127.0.0.1:5174';

const isWin = process.platform === 'win32';
const viteBin = path.join(CLIENT_ROOT, 'node_modules', '.bin', isWin ? 'vite.cmd' : 'vite');
const electronBin = path.join(
  CLIENT_ROOT,
  'node_modules',
  'electron',
  'dist',
  isWin ? 'electron.exe' : 'electron',
);

console.log('[dev] 启动 Vite 开发服务器（渲染进程热更新）…');
const vite = spawn(viteBin, ['--port', '5174', '--strictPort'], {
  cwd: CLIENT_ROOT,
  stdio: 'inherit',
  shell: isWin,
});

let electron = null;
let started = false;

function startElectron() {
  if (started) return;
  started = true;
  console.log('[dev] 启动 Electron 主进程…');
  electron = spawn(electronBin, [CLIENT_ROOT], {
    cwd: CLIENT_ROOT,
    stdio: 'inherit',
    env: { ...process.env, MCLINK_CLIENT_DEV_URL: DEV_URL, ELECTRON_ENABLE_LOGGING: '1' },
    shell: false,
  });
  electron.on('close', () => {
    console.log('[dev] Electron 已退出，关闭 Vite。');
    vite.kill();
    process.exit(0);
  });
}

// 等 Vite 起来（简单轮询，避免依赖额外工具）
const deadline = Date.now() + 30_000;
const timer = setInterval(async () => {
  try {
    const res = await fetch(DEV_URL, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      clearInterval(timer);
      startElectron();
    }
  } catch {
    if (Date.now() > deadline) {
      clearInterval(timer);
      console.error('[dev] 等待 Vite 超时，请检查 5174 端口是否被占用。');
      vite.kill();
      process.exit(1);
    }
  }
}, 600);

process.on('SIGINT', () => {
  electron?.kill();
  vite.kill();
  process.exit(130);
});
