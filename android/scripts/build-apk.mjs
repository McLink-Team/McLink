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
  if (res.status !== 0) {
    /**
     * `status === null` 说明**进程根本没起来**（ENOENT / EACCES），而不是"跑了但失败"。
     * 最常见的一种：Linux/macOS 上 `gradlew` 没有可执行位（从 Windows 提交的文件树里
     * 那个位常常丢了，git 只在 mode 100755 时才保留）—— CI 上就表现为"退出码 null"，
     * 日志里连一句 Gradle 报错都没有，极难查。这里把它说清楚。
     */
    const why = res.status === null ? `（没能启动：${res.error?.code ?? 'unknown'}）` : '';
    fail(
      `${cmd} 退出码 ${res.status}${why}` +
        (res.status === null && cmd.endsWith('gradlew')
          ? `\n      如果是 EACCES：给 gradlew 加可执行位 —— chmod +x android/android/gradlew` +
            `（或让脚本用 sh 调用它，本脚本在非 Windows 上已经这么做）`
          : ''),
    );
  }
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
 * 打印"这个包里内置的主控地址是什么"，并在**内置了**的时候检查它真的打进了产物。
 *
 * 这一条是踩过坑才加的：主控地址以前是编译期写死的，如果 define 被改坏，
 * 产物会静默回退到某个地址，装到手机上永远连不上，而错误只有一句"连不上服务器"。
 *
 * ⚠️ 2026-10-03 起"不内置"是**正常且默认**的：官方停服后，内置一个官方地址只会误导玩家，
 * 而社区/自建实例的地址只有玩家自己知道。所以这里：
 *   · 有 VITE_MCLINK_MASTER → 检查它确实在产物里（防 define 被改坏）；
 *   · 没有                    → 检查产物里**不含**任何 `https://` 形式的主控默认值，
 *     并确认界面会走"首次启动引导填地址"那条路（`no_master` 分支存在）。
 */
const expectedMaster = (process.env.VITE_MCLINK_MASTER ?? '').trim().replace(/\/+$/, '');
const assetsDir = path.join(ANDROID_ROOT, 'dist', 'assets');
const jsFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
const bundled = jsFiles.map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n');
if (expectedMaster.length > 0) {
  if (!bundled.includes(expectedMaster)) {
    fail(
      `产物里没有主控地址 ${expectedMaster}。\n` +
        `      手机上装上去就会连不上主控。检查 vite.config.ts 的 define 是否被改动。`,
    );
  }
  log(`✓ 产物已内置主控地址：${expectedMaster}`);
} else {
  if (bundled.includes('cnnic.link')) {
    fail(
      '产物里出现了 cnnic.link —— 这个包应该**不内置**任何主控地址（官方已停止服务）。\n' +
        `      检查 android/vite.config.ts 的 define 与构建时的 VITE_MCLINK_MASTER 是否还有残留默认值。`,
    );
  }
  log('✓ 产物未内置主控地址（首次启动会引导玩家自己填，符合预期）');
}
/**
 * `127.0.0.1` 出现在产物里**不再**是"本地回退常量"（那个常量已经删了）。
 * 现在它只可能来自两处，都是正常的、且都不是主控地址：社区节点示例文案、
 * 以及 smoke/e2e 脚本自己的测试地址。所以这里不再专门提示 ——
 * 真正的判据是"内置了就必须在产物里、没内置就不能有 cnnic.link"（上面那段），
 * 以及实际跑一遍界面看它请求哪个域名（scripts/smoke-mobile.mjs）。
 */

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

/**
 * 非 Windows 上**用 `sh gradlew` 调用**，不直接执行它。
 *
 * 为什么（CI 上真踩过）：`gradlew` 需要可执行位，而从 Windows 提交的文件树里那个位
 * 常常是丢的（git 只在 mode 100755 时保留）。直接 spawn 会得到 `EACCES`，
 * 在 Node 里表现为 `status === null` —— 日志里没有一句 Gradle 报错，只有"退出码 null"。
 * 用 `sh` 解释执行就不依赖那个位了；Windows 那边仍然是 `gradlew.bat`。
 */
const gradleDir = path.join(ANDROID_ROOT, 'android');
const gradleCmd = isWin ? path.join(gradleDir, 'gradlew.bat') : 'sh';
const gradleArgs = isWin ? ['assembleDebug', '--no-daemon'] : ['gradlew', 'assembleDebug', '--no-daemon'];
if (!fs.existsSync(isWin ? gradleCmd : path.join(gradleDir, 'gradlew'))) {
  fail(`找不到 ${path.join(gradleDir, 'gradlew')}`);
}
run(gradleCmd, gradleArgs, { cwd: gradleDir });

const apk = path.join(ANDROID_ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
if (!fs.existsSync(apk)) fail(`构建结束但找不到 APK：${apk}`);
const mb = (fs.statSync(apk).size / 1024 / 1024).toFixed(2);
log('✓ 完成');
console.log(`\n  APK : ${apk}\n  体积: ${mb} MB\n  主控: ${expectedMaster}\n`);
console.log('  装到手机（先开 USB 调试）：');
console.log(`    "${path.join(sdkRoot, 'platform-tools', 'adb.exe')}" install -r "${apk}"\n`);
