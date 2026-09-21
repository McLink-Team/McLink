#!/usr/bin/env node
/**
 * 打包 Windows 安装包（NSIS）+ 免安装 zip。
 * 依赖 electron-builder；首次运行会下载 NSIS 等工具（国内建议配置镜像，见 .npmrc）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(CLIENT_ROOT, '..');
const isWin = process.platform === 'win32';

// 1) 先构建渲染进程 + 准备 vendor
const build = spawnSync(process.execPath, [path.join(HERE, 'build.mjs')], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

// 2) 打包
const builderBin = path.join(CLIENT_ROOT, 'node_modules', '.bin', isWin ? 'electron-builder.cmd' : 'electron-builder');
if (!fs.existsSync(builderBin)) {
  console.error('[dist] 找不到 electron-builder，请先执行 pnpm install');
  process.exit(1);
}

const args = process.argv.slice(2);
const targets = args.length > 0 ? args : ['--win', 'nsis', 'zip'];
console.log(`[dist] electron-builder ${targets.join(' ')}`);
const res = spawnSync(builderBin, targets, {
  cwd: CLIENT_ROOT,
  stdio: 'inherit',
  shell: isWin,
  env: {
    ...process.env,
    // 国内镜像，避免下载 electron/nsis 资源超时
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  },
});
if (res.status !== 0) {
  console.error('[dist] 打包失败。若卡在下载 NSIS/winCodeSign，请检查网络或镜像设置。');
  process.exit(res.status ?? 1);
}
console.log('[dist] 完成，产物在 client/release');
