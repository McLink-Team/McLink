#!/usr/bin/env node
/**
 * 版本号一致性检查：**一个发行版本只有一个号**。
 *
 * 为什么值得单独一个脚本（1.1.0 发布时踩的坑）：改版本号时漏了 `android/package.json`
 * （还是 1.0.5），于是玩家装的明明是最新 APK，设置页却显示 `McLink 1.0.5`、
 * 还被主控提示"有新版本"。原因是同一个号在**四个地方**各写了一遍：
 *
 *   1. 各 package.json（root / client / server / web / packages/shared / android）
 *      —— `client` 与 `android` 的那份会**编译进安装包**（`__MCLINK_APP_VERSION__`），
 *      是 App 内显示与"要不要提示更新"的判据；
 *   2. `android/android/app/build.gradle` 的 `versionName` / `versionCode`
 *      —— Android 系统与升级用的，与上面必须一致（versionCode = 语义化版本的十进制编码）；
 *   3. 产物文件名（`McLink-Setup-<版本>-x64.exe` 之类）—— 由 electron-builder 与
 *      fetch-client-artifacts.mjs 生成，跟着 client/package.json 走；
 *   4. `docs/releases/<版本>.md` —— 发版说明，缺了就说明"版本号改了但说明没写"。
 *
 * 用法（无需主控、毫秒级）：
 *   node scripts/check-versions.mjs
 *   node scripts/check-versions.mjs 1.1.0        # 顺便断言"当前就是发这个版本"
 *
 * 加了新包（新的 package.json 成员）时把它加进下面 WORKSPACE_PACKAGES 即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 要参与一致性检查的 package.json（相对仓库根） */
const WORKSPACE_PACKAGES = [
  'package.json',
  'client/package.json',
  'server/package.json',
  'web/package.json',
  'packages/shared/package.json',
  'android/package.json',
];

const want = process.argv[2] ?? null;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`);
};

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
const versions = new Map();
for (const rel of WORKSPACE_PACKAGES) {
  if (!fs.existsSync(path.join(REPO, rel))) continue;
  versions.set(rel, readJson(rel).version);
}
const unique = new Set(versions.values());
const version = [...versions.values()][0];

console.log(`版本检查（共 ${versions.size} 个 package.json）`);
for (const [rel, v] of versions) console.log(`  ${v.padEnd(10)} ${rel}`);
console.log('');

check('所有 package.json 的版本号一致', unique.size === 1, unique.size === 1 ? version : [...unique].join(' / '));

if (want) {
  check(`当前版本就是 ${want}`, version === want, `实际 ${version}`);
}

/* ---------------------------------------------------- Android 原生工程 */
const gradleRel = 'android/android/app/build.gradle';
if (fs.existsSync(path.join(REPO, gradleRel)) && version) {
  const gradle = fs.readFileSync(path.join(REPO, gradleRel), 'utf8');
  const name = /versionName\s+"([^"]+)"/.exec(gradle)?.[1] ?? null;
  const code = Number(/versionCode\s+(\d+)/.exec(gradle)?.[1] ?? Number.NaN);
  check(`${gradleRel} 的 versionName 与包版本一致`, name === version, `versionName=${name} package=${version}`);
  /**
   * versionCode 是语义化版本的十进制编码：major*100 + minor*10 + patch
   * （1.0.5 → 105、1.1.0 → 110）。这样"版本变大 ⇒ versionCode 变大"永远成立，
   * Android 才会允许覆盖安装。
   */
  const expectedCode = version
    ? version
        .split('.')
        .map((n) => Number.parseInt(n, 10))
        .reduce((acc, n, i) => acc + n * 10 ** (2 - i), 0)
    : Number.NaN;
  check(
    `${gradleRel} 的 versionCode 是版本号的十进制编码（${version} → ${expectedCode}）`,
    code === expectedCode,
    `versionCode=${code}`,
  );
}

/* ---------------------------------------------------- 主控自身的版本常量 */
/**
 * `server/src/app.ts` 的 `APP_VERSION` 是主控对外宣称的版本
 * （`/meta.version`、启动日志、落地页页脚、WS hello 都用它）。
 * 1.1.0 发版时它漏改了 —— 页脚显示 1.0.9 而客户端是 1.1.0，玩家会以为版本对不上。
 */
const appVersionRel = 'server/src/app.ts';
if (fs.existsSync(path.join(REPO, appVersionRel)) && version) {
  const src = fs.readFileSync(path.join(REPO, appVersionRel), 'utf8');
  const declared = /export const APP_VERSION = '([^']+)'/.exec(src)?.[1] ?? null;
  check(`${appVersionRel} 的 APP_VERSION 与包版本一致`, declared === version, `APP_VERSION=${declared} package=${version}`);
}

/* ---------------------------------------------------- 发版说明 */
if (version) {
  const notes = `docs/releases/${version}.md`;
  check(`发版说明 ${notes} 存在`, fs.existsSync(path.join(REPO, notes)), fs.existsSync(path.join(REPO, notes)) ? '' : '缺这个文件');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
