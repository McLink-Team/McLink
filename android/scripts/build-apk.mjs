#!/usr/bin/env node
/**
 * 一键产出 debug APK。
 *
 * 为什么用 Node 而不是 .ps1：仓库里 client/scripts/*.mjs 都是这个套路
 * （见 client/scripts/build.mjs），而且 Node 在 Windows 上 spawn 一个 .bat
 * 比 PowerShell 里处理引号/路径空格省事得多。SDK 的安装另外交给
 * scripts/bootstrap-android-sdk.ps1（那件事本质是下载+解压，PowerShell 更合适）。
 *
 * 用法：
 *   node android/scripts/build-apk.mjs
 *   VITE_MCLINK_MASTER=https://cnnic.link node android/scripts/build-apk.mjs
 *
 * 做四件事：
 *   1. 检查 SDK 是否存在（不存在就打印补齐命令，**不是**抛一个看不懂的 Gradle 错误）；
 *   2. vite build —— 把 client/src 的页面打成 web 资产；
 *   3. cap sync android —— 把资产与插件清单同步进原生工程；
 *   4. gradlew assembleDebug —— 出 APK，并打印路径与体积。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANDROID_ROOT = path.resolve(HERE, '..');
const isWin = process.platform === 'win32';

/** 与 scripts/bootstrap-android-sdk.ps1 的默认值保持一致 */
const DEFAULT_SDK = 'F:\\android-sdk';

function log(msg) {
  console.log(`[apk] ${msg}`);
}
function fail(msg) {
  console.error(`[apk] ✗ ${msg}`);
  process.exit(1);
}

/* ------------------------------------------------------------ 1. SDK 检查 */

const sdkRoot = (process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || DEFAULT_SDK).trim();
if (!fs.existsSync(sdkRoot)) {
  fail(
    `找不到 Android SDK：${sdkRoot}\n` +
      `      先跑一次（约 550MB，装到仓库外）：\n` +
      `        node --version >/dev/null && powershell -ExecutionPolicy Bypass -File android/scripts/bootstrap-android-sdk.ps1\n` +
      `      或者把已有 SDK 的路径指过来：\n` +
      `        $env:ANDROID_HOME = "D:\\android-sdk"  (PowerShell)\n` +
      `      缺的组件是：platform-tools、platforms;android-35、build-tools;35.0.0。`,
  );
}
const hasPlatform = fs.existsSync(path.join(sdkRoot, 'platforms', 'android-35'));
const hasBuildTools = fs.existsSync(path.join(sdkRoot, 'build-tools', '35.0.0'));
if (!hasPlatform || !hasBuildTools) {
  fail(
    `SDK 在 ${sdkRoot}，但缺组件：` +
      `${hasPlatform ? '' : 'platforms;android-35 '}${hasBuildTools ? '' : 'build-tools;35.0.0'}\n` +
      `      补齐： "${path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat')}" ` +
      `"platforms;android-35" "build-tools;35.0.0"`,
  );
}

/**
 * 写 local.properties。
 *
 * 这是 Gradle 找 SDK 的**本机**配置（相对的是环境变量 ANDROID_HOME，那个在 IDE 里
 * 常常没继承到）。它已经在 android/.gitignore 里 —— 里面是这台机器的绝对路径。
 * 每次都写一遍：SDK 换了位置时，过期的 local.properties 会以
 * "SDK location not found" 的形式报错，而那句话完全不提它读的是哪个文件。
 */
const localProps = path.join(ANDROID_ROOT, 'android', 'local.properties');
if (fs.existsSync(path.dirname(localProps))) {
  // Gradle 的 properties 是 java.util.Properties 格式：反斜杠是转义字符，必须写成 \\
  fs.writeFileSync(localProps, `# 由 scripts/build-apk.mjs 自动生成，请勿提交\nsdk.dir=${sdkRoot.replace(/\\/g, '\\\\')}\n`);
  log(`local.properties → sdk.dir=${sdkRoot}`);
}

/* --------------------------------------------------------------- 工具 */

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin, cwd: opts.cwd ?? ANDROID_ROOT, env: process.env });
  if (res.status !== 0) fail(`${cmd} 退出码 ${res.status}`);
}

const bin = (pkg, name) => path.join(ANDROID_ROOT, 'node_modules', '.bin', isWin ? `${name}.cmd` : name);

/* ------------------------------------------------------------ 2. 前端资产 */

if (!fs.existsSync(bin('vite', 'vite'))) {
  fail('依赖没装。先在仓库根跑：pnpm install');
}
run(bin('vite', 'vite'), ['build'], { cwd: ANDROID_ROOT });
if (!fs.existsSync(path.join(ANDROID_ROOT, 'dist', 'index.html'))) {
  fail('vite build 没产出 dist/index.html');
}

/**
 * 把内置的主控地址**打印出来**，并且检查它真的打进了产物。
 *
 * 这一条是踩过坑才加的：主控地址是编译期内置的，如果哪天 define 被改坏，
 * 产物会静悄悄回退到 http://127.0.0.1:8787（api.ts 的 DEV_FALLBACK_MASTER），
 * 于是装到手机上永远连不上，而错误只有一句"连不上服务器"。
 * 在这里对产物做一次字符串检查，问题就会在构建时暴露。
 */
const expectedMaster = (process.env.VITE_MCLINK_MASTER ?? 'https://cnnic.link').trim().replace(/\/+$/, '');
const assetsDir = path.join(ANDROID_ROOT, 'dist', 'assets');
const jsFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
const bundled = jsFiles.map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n');
if (!bundled.includes(expectedMaster)) {
  fail(
    `产物里没有主控地址 ${expectedMaster}。\n` +
      `      手机上装上去就会连不上主控。检查 vite.config.ts 的 define 是否被改动。`,
  );
}
log(`✓ 产物已内置主控地址：${expectedMaster}`);
/**
 * 产物里**同时**会出现 api.ts 的 DEV_FALLBACK_MASTER 字面量（127.0.0.1:8787）——
 * 这是正常的，不是配置没生效：
 *   · define 把 `import.meta.env.VITE_MCLINK_MASTER` 换成了上面那个字面量，
 *     `readEnvMaster()` 因此返回官方主控；
 *   · 于是 `USING_DEV_MASTER = !"https://cnnic.link"` 被常量折叠成 false；
 *   · 而 `const DEV_FALLBACK_MASTER = 'http://127.0.0.1:8787'` 是**源码里的常量**，
 *     打包器不会因为没人用就删掉一个模块级常量（除非开了更激进的摇树）。
 * 所以这一条只提示、不作为失败判据。真正的判据在下一条：实际跑一遍界面，
 * 看它请求的是哪个域名（scripts/smoke-mobile.mjs）。
 */
if (bundled.includes('127.0.0.1:8787')) {
  log('· 产物里另有 api.ts 的本地回退常量 127.0.0.1:8787（未被使用，见脚本注释）');
}

/* --------------------------------------------------------- 3. cap sync */

const capBin = bin('@capacitor/cli', 'cap');
if (!fs.existsSync(capBin)) fail('没找到 @capacitor/cli。先在仓库根跑：pnpm install');
if (!fs.existsSync(path.join(ANDROID_ROOT, 'android'))) {
  fail(
    '还没生成原生工程（android/android/ 不存在）。先跑一次：\n' +
      '        npx cap add android\n' +
      '      （需要 node_modules 已装好；生成后那个目录是要入库的，它是外壳的源码）',
  );
}
run(capBin, ['sync', 'android'], { cwd: ANDROID_ROOT });

/* ------------------------------------------------------------ 4. 出包 */

const gradlew = path.join(ANDROID_ROOT, 'android', isWin ? 'gradlew.bat' : './gradlew');
if (!fs.existsSync(gradlew)) fail(`找不到 ${gradlew}`);
run(gradlew, ['assembleDebug', '--no-daemon'], { cwd: path.join(ANDROID_ROOT, 'android') });

const apk = path.join(ANDROID_ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
if (!fs.existsSync(apk)) fail(`构建结束但找不到 APK：${apk}`);
const mb = (fs.statSync(apk).size / 1024 / 1024).toFixed(2);
log('✓ 完成');
console.log(`\n  APK : ${apk}\n  体积: ${mb} MB\n  主控: ${expectedMaster}\n`);
console.log('  装到手机（先开 USB 调试）：');
console.log(`    "${path.join(sdkRoot, 'platform-tools', 'adb.exe')}" install -r "${apk}"\n`);
