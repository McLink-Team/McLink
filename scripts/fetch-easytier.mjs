#!/usr/bin/env node
/**
 * 下载并解压 EasyTier 官方发行包到 vendor/easytier/。
 *
 * 用法：
 *   node scripts/fetch-easytier.mjs                 # 当前平台
 *   node scripts/fetch-easytier.mjs --all           # Windows + Linux 都下
 *   node scripts/fetch-easytier.mjs --version v2.6.4
 *
 * 说明：官方只提供 zip。Windows 10+ 自带 bsdtar，Linux 上用 unzip，
 * 因此不引第三方解压依赖。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(REPO_ROOT, 'vendor', 'easytier');
const CACHE = path.join(REPO_ROOT, '.cache', 'easytier-downloads');

const args = process.argv.slice(2);
const all = args.includes('--all');
const versionArg = args.find((a) => a.startsWith('--version=')) ?? args[args.indexOf('--version') + 1];
const VERSION = versionArg && /^v?\d/.test(versionArg) ? versionArg.replace(/^v?/, 'v') : 'v2.6.4';

/**
 * EasyTier 官方资产的**真实命名**（对齐 v2.6.4 的 release 资产列表）。
 *
 * 这里必须逐个写死，不能按"平台 + 宿主架构"拼字符串 —— 官方命名并不统一：
 *   Windows arm64 → `easytier-windows-arm64-…`      （说 arm64）
 *   Linux   arm64 → `easytier-linux-aarch64-…`      （说 aarch64）
 *   macOS   arm64 → `easytier-macos-aarch64-…`      （说 aarch64）
 * 曾经就是按宿主架构统一拼的：在 arm64 的 macOS runner 上跑 --all，
 * 会去要 `easytier-linux-arm64-…zip` → 404 → 整个 CI job 失败。
 */
const ASSETS = {
  'windows-x64': { asset: (v) => `easytier-windows-x86_64-${v}.zip`, subdir: null },
  'windows-arm64': { asset: (v) => `easytier-windows-arm64-${v}.zip`, subdir: null },
  'linux-x64': { asset: (v) => `easytier-linux-x86_64-${v}.zip`, subdir: null },
  'linux-arm64': { asset: (v) => `easytier-linux-aarch64-${v}.zip`, subdir: null },
  'macos-arm64': { asset: (v) => `easytier-macos-aarch64-${v}.zip`, subdir: 'macos-arm64' },
  'macos-x64': { asset: (v) => `easytier-macos-x86_64-${v}.zip`, subdir: 'macos-x64' },
};

/** 根据命令行参数或宿主平台决定要取哪些目标 */
function targets() {
  const args = process.argv.slice(2);
  const pick = (...keys) => keys.map((k) => ({ key: k, ...ASSETS[k], name: ASSETS[k].asset(VERSION) }));

  if (all) return pick('windows-x64', 'linux-x64', 'macos-arm64', 'macos-x64');
  if (args.includes('--macos')) return pick('macos-arm64', 'macos-x64');
  if (args.includes('--windows')) return pick(process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64');
  if (args.includes('--linux')) return pick(process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64');

  // 不给参数：按宿主平台取"这台机器上真正要用的那一份"
  if (process.platform === 'darwin') return pick(process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64');
  if (process.platform === 'win32') return pick(process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64');
  return pick(process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64');
}

async function download(url, out) {
  if (fs.existsSync(out) && fs.statSync(out).size > 1024 * 1024) {
    console.log(`已存在，跳过下载: ${path.basename(out)}`);
    return out;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  console.log(`下载 ${url}`);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(900_000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const chunks = [];
  let got = 0;
  let lastLog = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    if (Date.now() - lastLog > 3000) {
      lastLog = Date.now();
      const pct = total ? ` (${((got / total) * 100).toFixed(0)}%)` : '';
      process.stdout.write(`  ${(got / 1048576).toFixed(1)}MB${pct}\n`);
    }
  }
  fs.writeFileSync(out, Buffer.concat(chunks));
  console.log(`  完成: ${(got / 1048576).toFixed(1)}MB`);
  return out;
}

function extract(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  // bsdtar / GNU tar 都能处理 zip
  const res = spawnSync(tar, ['-xf', zipFile, '-C', destDir], { stdio: 'inherit' });
  if (res.status !== 0) {
    const unzip = spawnSync('unzip', ['-o', zipFile, '-d', destDir], { stdio: 'inherit' });
    if (unzip.status !== 0) throw new Error('解压失败：请确认系统有 tar 或 unzip');
  }
}

/**
 * 把解压出来的文件铺到目标目录。
 *
 * 注意参数是**两个**目录：源（解压临时目录）与目标。
 * 上一版只有一个参数、并把它同时当源和目标用，macOS 分支于是把二进制拷进了
 * `.cache/…/extract-mac/macos-arm64/` —— 而不是 `vendor/easytier/macos-arm64/`，
 * 结果 electron-builder 报 `file source doesn't exist from=…/vendor/easytier/macos-arm64`，
 * 打出来的包里**没有 EasyTier 核心**（CI 日志实锤）。
 * 日志里那句"已安装 -> vendor/..."是拼出来的字符串，掩盖了这个错误。
 */
function flatten(srcDir, destDir, { onlyBinaries = false } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(srcDir, entry.name);
    for (const file of fs.readdirSync(nested)) {
      const from = path.join(nested, file);
      if (!fs.statSync(from).isFile()) continue;
      // macOS 只搬运行时要用的两个二进制（web 版对客户端没用，白白多占 40MB）
      if (onlyBinaries && !/^easytier-(core|cli)$/.test(file)) continue;
      const to = path.join(destDir, file);
      fs.copyFileSync(from, to);
      if (onlyBinaries) fs.chmodSync(to, 0o755);
    }
    fs.rmSync(nested, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(VENDOR, { recursive: true });
  for (const { key, name, subdir } of targets()) {
    const url = `https://github.com/EasyTier/EasyTier/releases/download/${VERSION}/${name}`;
    const zip = path.join(CACHE, name);
    // macOS 解到临时目录再筛（只留 core/cli），其它平台直接铺进 vendor/
    const extractDir = subdir ? path.join(CACHE, 'extract-mac') : VENDOR;
    const destDir = subdir ? path.join(VENDOR, subdir) : VENDOR;
    try {
      await download(url, zip);
      extract(zip, extractDir);
      flatten(extractDir, destDir, { onlyBinaries: Boolean(subdir) });
      console.log(`已安装 ${name}（${key}）-> ${destDir}`);
    } catch (err) {
      console.error(`处理 ${name} 失败: ${err.message}`);
      if (/fetch failed|ENOTFOUND|timeout/i.test(err.message)) {
        console.error('提示：若处于受限网络，请设置 HTTPS_PROXY 与 NODE_USE_ENV_PROXY=1 后重试。');
      }
      process.exitCode = 1;
    }
  }
  const files = fs.readdirSync(VENDOR).filter((f) => f.includes('easytier-'));
  console.log('\nvendor/easytier 内容:');
  for (const f of files) {
    console.log(`  ${f}  ${(fs.statSync(path.join(VENDOR, f)).size / 1048576).toFixed(1)}MB`);
  }
  for (const sub of ['macos-arm64', 'macos-x64']) {
    const dir = path.join(VENDOR, sub);
    if (!fs.existsSync(dir)) continue;
    console.log(`  ${sub}/`);
    for (const f of fs.readdirSync(dir)) {
      console.log(`    ${f}  ${(fs.statSync(path.join(dir, f)).size / 1048576).toFixed(1)}MB`);
    }
  }
}

await main();
