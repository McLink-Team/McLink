#!/usr/bin/env node
/**
 * 构建渲染进程，并把 easytier 二进制一起准备到 vendor/ 供打包使用。
 * 主进程与 preload 是纯 JS，不需要打包。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(CLIENT_ROOT, '..');
const isWin = process.platform === 'win32';

console.log('[build] 构建渲染进程…');
// 用本包自己的 .bin：pnpm 把依赖装在各自的 node_modules 下
const viteBin = path.join(CLIENT_ROOT, 'node_modules', '.bin', isWin ? 'vite.cmd' : 'vite');
const res = spawnSync(viteBin, ['build'], {
  cwd: CLIENT_ROOT,
  stdio: 'inherit',
  shell: isWin,
});
if (res.status !== 0) {
  console.error('[build] 渲染进程构建失败');
  process.exit(res.status ?? 1);
}

// 打包时需要把 easytier-core / cli / wintun.dll 一起带上
const vendorSrc = path.join(REPO_ROOT, 'vendor', 'easytier');
const vendorDst = path.join(CLIENT_ROOT, 'vendor', 'easytier');
if (fs.existsSync(vendorSrc)) {
  fs.mkdirSync(vendorDst, { recursive: true });
  let copied = 0;
  for (const name of fs.readdirSync(vendorSrc)) {
    if (!/^easytier-(core|cli)(\.exe)?$/.test(name) && !/^wintun\.dll$/i.test(name)) continue;
    fs.copyFileSync(path.join(vendorSrc, name), path.join(vendorDst, name));
    copied += 1;
  }
  console.log(`[build] 已复制 ${copied} 个 EasyTier 文件到 client/vendor/easytier`);
} else {
  console.warn('[build] 未找到 vendor/easytier，打包出的客户端将缺少 EasyTier 核心。请先运行 pnpm fetch:easytier');
}
console.log('[build] 完成。渲染产物：client/dist');
