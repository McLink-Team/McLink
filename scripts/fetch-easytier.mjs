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

function assetNames() {
  const names = [];
  const platformWanted = all ? ['windows', 'linux'] : [process.platform === 'win32' ? 'windows' : 'linux'];
  for (const p of platformWanted) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    names.push(`easytier-${p}-${arch}-${VERSION}.zip`);
  }
  return names;
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

/** 把解压出来的文件铺平到 vendor/easytier/，方便服务端用固定路径引用 */
function flatten(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(dir, entry.name);
    for (const file of fs.readdirSync(nested)) {
      const from = path.join(nested, file);
      if (!fs.statSync(from).isFile()) continue;
      fs.copyFileSync(from, path.join(VENDOR, file));
    }
    fs.rmSync(nested, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(VENDOR, { recursive: true });
  for (const name of assetNames()) {
    const url = `https://github.com/EasyTier/EasyTier/releases/download/${VERSION}/${name}`;
    const zip = path.join(CACHE, name);
    try {
      await download(url, zip);
      extract(zip, VENDOR);
      flatten(VENDOR);
      console.log(`已安装 ${name} -> ${VENDOR}`);
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
}

await main();
