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
const args = process.argv.slice(2);

/**
 * 主控地址是编译期嵌入的，但**现在是可选的**（2026-10-03 改）。
 *
 * 以前这里"缺少 VITE_MCLINK_MASTER 就直接失败"，理由是"正式安装包必须内嵌官方主控地址"。
 * 官方停服之后这条前提反了：内置一个官方地址才会误导玩家（那台机器不再提供服务），
 * 而社区/自建实例的地址只有玩家自己知道。
 *
 * 现在的口径：
 *   · 给了 VITE_MCLINK_MASTER  → 嵌进去当默认值（自建实例自己出包时用）；
 *   · 没给                      → 产物**不含任何主控地址**，首次启动引导玩家自己填
 *     （见 client/src/pages/LoginPage.vue 的 needsMaster 首屏）。
 * 两种都是合法产物，所以不再退出。
 */
const master = (process.env.VITE_MCLINK_MASTER ?? '').trim().replace(/\/+$/, '');
console.log(
  master.length > 0
    ? `[dist] 内置主控地址: ${master}`
    : '[dist] 不内置主控地址：首次启动会引导玩家自己填（客户端「自建 / 社区节点」）',
);
process.env.VITE_MCLINK_MASTER = master;

// 1) 先构建渲染进程 + 准备 vendor
const build = spawnSync(process.execPath, [path.join(HERE, 'build.mjs')], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  env: { ...process.env, VITE_MCLINK_MASTER: master },
});
if (build.status !== 0) process.exit(build.status ?? 1);

// 2) 打包
const builderBin = path.join(CLIENT_ROOT, 'node_modules', '.bin', isWin ? 'electron-builder.cmd' : 'electron-builder');
if (!fs.existsSync(builderBin)) {
  console.error('[dist] 找不到 electron-builder，请先执行 pnpm install');
  process.exit(1);
}

const targets = args.filter((a) => !a.startsWith('--allow'));
const finalTargets = targets.length > 0 ? targets : ['--win', 'nsis', 'zip'];
console.log(`[dist] electron-builder ${finalTargets.join(' ')}`);
const res = spawnSync(builderBin, finalTargets, {
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
  /**
   * 报错要指向真正的原因。
   * 之前只有一句"若卡在下载 NSIS/winCodeSign 请检查网络"，于是
   * "在 Windows 上构建 macOS 包"这种**根本不支持**的用法会被误读成网络问题
   * （实测：日志里其实明写着 Build for macOS is supported only on macOS）。
   */
  const wantsMac = finalTargets.some((t) => t === '--mac' || t === 'mac');
  if (wantsMac && process.platform !== 'darwin') {
    console.error(
      '[dist] 打包失败：electron-builder 不支持在非 macOS 上构建 macOS 包。\n' +
        '       请改用托管的 macOS runner（.github/workflows/build-clients.yml）或一台 Mac，\n' +
        '       详见 docs/build-clients.md。',
    );
  } else {
    console.error('[dist] 打包失败。若卡在下载 NSIS/winCodeSign，请检查网络或镜像设置。');
  }
  process.exit(res.status ?? 1);
}
console.log('[dist] 完成，产物在 client/release');
