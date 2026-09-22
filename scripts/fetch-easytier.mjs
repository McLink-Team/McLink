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
 * 要下载哪些平台的包。
 *
 * macOS 的命名规则与其它平台**不同**：官方是 `easytier-macos-aarch64-…` /
 * `easytier-macos-x86_64-…`（用 aarch64 而不是 arm64），而且它的二进制**不能**铺平
 * 到 vendor/easytier/ 根目录 —— 那里放的是 Windows(.exe) 与 Linux(无扩展名) 版，
 * mac 版必须落在 `macos-arm64/` 与 `macos-x64/` 子目录里，
 * 运行时由 main.cjs 的 platformVendorSubdir() 按 process.arch 选。
 */
function targets() {
  const wanted = all
    ? ['windows', 'linux', 'macos-arm64', 'macos-x64']
    : process.platform === 'darwin'
      ? [process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64']
      : [process.platform === 'win32' ? 'windows' : 'linux'];
  return wanted.map((p) => {
    if (p === 'macos-arm64') return { target: p, asset: `easytier-macos-aarch64-${VERSION}.zip`, subdir: 'macos-arm64' };
    if (p === 'macos-x64') return { target: p, asset: `easytier-macos-x86_64-${VERSION}.zip`, subdir: 'macos-x64' };
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    return { target: p, asset: `easytier-${p}-${arch}-${VERSION}.zip`, subdir: null };
  });
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

/** 把解压出来的文件铺平到 vendor/easytier/（macOS 走 subdir，不铺平） */
function flatten(dir, subdir = null) {
  const dest = subdir ? path.join(dir, subdir) : dir;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(dir, entry.name);
    // macOS 包解出来是 easytier-macos-<arch>/ 一层目录，整目录搬进子目录
    if (subdir) {
      for (const file of fs.readdirSync(nested)) {
        const from = path.join(nested, file);
        if (!fs.statSync(from).isFile()) continue;
        // 只搬运行时要用的两个二进制（web 版对客户端没用，白白多占 40MB）
        if (!/^easytier-(core|cli)$/.test(file)) continue;
        fs.copyFileSync(from, path.join(dest, file));
        fs.chmodSync(path.join(dest, file), 0o755);
      }
      fs.rmSync(nested, { recursive: true, force: true });
      continue;
    }
    for (const file of fs.readdirSync(nested)) {
      const from = path.join(nested, file);
      if (!fs.statSync(from).isFile()) continue;
      fs.copyFileSync(from, path.join(dest, file));
    }
    fs.rmSync(nested, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(VENDOR, { recursive: true });
  for (const { asset, subdir } of targets()) {
    const url = `https://github.com/EasyTier/EasyTier/releases/download/${VERSION}/${asset}`;
    const zip = path.join(CACHE, asset);
    try {
      await download(url, zip);
      // macOS 解到临时目录再筛，避免把 web 版塞进子目录
      extract(zip, subdir ? path.join(CACHE, 'extract-mac') : VENDOR);
      flatten(subdir ? path.join(CACHE, 'extract-mac') : VENDOR, subdir);
      console.log(`已安装 ${asset} -> ${subdir ? path.join(VENDOR, subdir) : VENDOR}`);
    } catch (err) {
      console.error(`处理 ${asset} 失败: ${err.message}`);
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
