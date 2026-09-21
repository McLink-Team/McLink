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

/**
 * 主控地址是编译期常量（客户端不支持自建主控）。
 * 这里把最终生效值打印出来，避免"以为打的是线上包，实际指向 localhost"这类事故。
 */
const master = (process.env.VITE_MCLINK_MASTER ?? '').trim();
if (master.length === 0) {
  console.warn('[build] 未设置 VITE_MCLINK_MASTER，客户端将使用本地开发地址 http://127.0.0.1:8787');
  console.warn('[build] 正式发包请设置：VITE_MCLINK_MASTER=https://你的主控域名 pnpm dist:client');
} else {
  console.log(`[build] 已内嵌主控地址：${master}`);
}

/**
 * 打包时要带上哪些 EasyTier 文件。
 *
 *   easytier-core.exe / easytier-cli.exe —— 隧道进程与我方查询工具
 *   wintun.dll                           —— 创建 TUN 网卡
 *   WinDivert64.sys / Packet.dll         —— 局域网广播直通（默认关闭，但房主可开启）
 *
 * 为什么写死清单而不是按通配符拷：
 *   1. 之前的规则是 `/^easytier-(core|cli)(\.exe)?$/`，于是把 **Linux 二进制**也打进了
 *      Windows 安装包（白涨约 10MB）；
 *   2. 更糟的是它漏掉了 WinDivert64.sys —— 打包版客户端打开「局域网广播直通」会静默失效，
 *      而开发模式一切正常（开发模式读的是仓库根目录的 vendor/，那里文件是全的）。
 *      这种「开发正常、装完就坏」的差异极难排查，所以清单必须显式且带缺失告警。
 */
const WANTED_VENDOR_FILES = [
  'easytier-core.exe',
  'easytier-cli.exe',
  'wintun.dll',
  'WinDivert64.sys',
  'Packet.dll',
];

const vendorSrc = path.join(REPO_ROOT, 'vendor', 'easytier');
// 打包时读的是 client/vendor（electron-builder 的 from 相对 client/ 解析）
const vendorDst = path.join(CLIENT_ROOT, 'vendor', 'easytier');
if (fs.existsSync(vendorSrc)) {
  fs.mkdirSync(vendorDst, { recursive: true });
  // 先清掉上一次遗留的多余文件，否则旧的 Linux 二进制会一直躺在安装包里
  let removed = 0;
  for (const name of fs.readdirSync(vendorDst)) {
    if (WANTED_VENDOR_FILES.includes(name)) continue;
    fs.rmSync(path.join(vendorDst, name), { force: true, recursive: true });
    removed += 1;
  }
  let copied = 0;
  const missing = [];
  for (const name of WANTED_VENDOR_FILES) {
    const from = path.join(vendorSrc, name);
    if (!fs.existsSync(from)) {
      missing.push(name);
      continue;
    }
    fs.copyFileSync(from, path.join(vendorDst, name));
    copied += 1;
  }
  console.log(
    `[build] 已准备 ${copied} 个 EasyTier 文件到 client/vendor/easytier` +
      (removed > 0 ? `（清理掉 ${removed} 个不属于 Windows 端的旧文件）` : ''),
  );
  if (missing.length > 0) {
    console.warn(
      `[build] ⚠ 仓库 vendor/easytier 里缺少：${missing.join(', ')}\n` +
        '        缺 easytier-core.exe 客户端将无法联机；缺 WinDivert64.sys/Packet.dll 时\n' +
        '        「局域网广播直通」在打包版里会静默失效。请先运行 pnpm fetch:easytier。',
    );
  }
} else {
  console.warn('[build] 未找到 vendor/easytier，打包出的客户端将缺少 EasyTier 核心。请先运行 pnpm fetch:easytier');
}
console.log('[build] 完成。渲染产物：client/dist');
