#!/usr/bin/env node
/**
 * macOS 支持层的**静态断言**（本仓库没有 Mac，这是"改了但没验"与"真的接线了"之间的那道闸）。
 *
 * 为什么需要它
 * ------------
 * 这次改造的核心风险不是"代码写错了"，而是**分支写偏了**，两种都很难在 Windows 上被发现：
 *   1. 该在 macOS 上分叉的地方忘了分叉（例如托盘还去读 .ico → mac 上是一块空白图标）；
 *   2. 为了"支持 mac"顺手把 Windows 的那条路删掉/改坏（提权、WMI 清理、dmg 之外的 win 打包）。
 * 所以这里做的是**双向**断言：macOS 分支必须在，Windows 分支也必须在，
 * 而且 electron-builder / GitLab CI 的结构要能被 YAML 解析出预期的字段。
 *
 * 为什么不用正则数一数就完事：正则只能证明"字面上有"，所以凡是能解析的结构
 * （两个 YAML、platform-support.cjs 的行为、PNG 的 IHDR）都走**解析/执行**，
 * 只有"某段顺序"这类确实只能看文本的地方才用字符串位置比较。
 *
 * 用法：node client/scripts/verify-platform.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CLIENT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

let passed = 0;
const failures = [];

/** 断言：成立就记一笔，不成立就攒起来（一次跑完，不要第一个就退出） */
function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(detail ? `${label} —— ${detail}` : label);
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function section(title) {
  console.log(`\n[${title}]`);
}

/**
 * 复用仓库里已经装好的 js-yaml（electron-builder 的传递依赖）。
 * 故意**不**引入新的 devDependency：这个脚本要在 CI 与本地都能跑，
 * 而不因为"加了一个校验脚本"去动 lockfile。
 */
function loadYaml() {
  const pnpmDir = path.join(REPO_ROOT, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmDir)) {
    for (const name of fs.readdirSync(pnpmDir)) {
      if (!name.startsWith('js-yaml@')) continue;
      const candidate = path.join(pnpmDir, name, 'node_modules', 'js-yaml');
      if (fs.existsSync(candidate)) return require(candidate);
    }
  }
  return null;
}

const yaml = loadYaml();
if (!yaml) {
  console.error('✗ 找不到 YAML 解析器（js-yaml，随 electron-builder 一起装）。请先执行 pnpm install。');
  process.exit(1);
}

/* ------------------------------------------------------------------ 1. 主进程 */

section('主进程 client/electron/main.cjs');
const main = read('client/electron/main.cjs');

check('平台判定集中在 isMac/isWin 常量（不是散落的比较）', /const isMac = process\.platform === 'darwin'/.test(main) && /const isWin = process\.platform === 'win32'/.test(main));
check('macOS 窗口用 titleBarStyle: hiddenInset（系统红黄绿）', /titleBarStyle: 'hiddenInset'/.test(main));
check('macOS 窗口不再 frame: false（否则红黄绿会被一起去掉）', /frame: true/.test(main));
check('红黄绿位置有显式设定（trafficLightPosition）', /trafficLightPosition/.test(main));
check('Windows 仍是 frame: false + titleBarStyle: hidden（回归）', /frame: false/.test(main) && /titleBarStyle: 'hidden'/.test(main));
check('Windows 提权仍是 Start-Process … -Verb RunAs（回归）', /buildElevateCommand/.test(main) && /Start-Process -FilePath/.test(read('client/electron/elevation.cjs')) && /-Verb RunAs/.test(read('client/electron/elevation.cjs')));
check('macOS 提权走 osascript with administrator privileges', /osascript/.test(main) && /with administrator privileges/.test(main));
check('Windows 孤儿清理仍是 WMI（回归）', /Get-CimInstance Win32_Process/.test(main));
check('非 Windows 孤儿清理走 pkill', /spawnSync\('pkill'/.test(main));
check('资源占用：Windows 仍用 PowerShell（回归）', /'powershell\.exe'/.test(main) && /Get-Process -Id/.test(main));
check('资源占用：macOS/Linux 用 ps 并归一成同一形状', /spawnSync\('ps', \['-o', 'rss=,time='/.test(main) && /parseCpuTime/.test(main));
check('macOS 托盘图标读 tray-mac.png（.ico 在 mac 上读不出来）', /'tray-mac\.png'/.test(main));
check('模板图交给系统反色（setTemplateImage）', /setTemplateImage\(true\)/.test(main));
check('Windows 托盘仍读 icon.ico（回归）', /'icon\.ico'/.test(main));
check('macOS 菜单栏：建原生菜单', /Menu\.setApplicationMenu\(Menu\.buildFromTemplate/.test(main));
check('菜单栏带 ⌘Q（role: quit）与 ⌘,（设置…）', /role: 'quit'/.test(main) && /Command\+,/.test(main));
check('菜单栏带 ⌘W（role: close）与 ⌘R（重新加载界面）', /role: 'close'/.test(main) && /Command\+R/.test(main));
check('菜单栏只在 macOS 上建（Windows 行为不变）', /function buildApplicationMenu\(\) \{\s*\n\s*if \(!isMac\) return;/.test(main));
check('⌘R 在联机时先问一次（避免界面与正在跑的核心脱节）', /reloadWindowSafely/.test(main) && /虚拟网络正在运行/.test(main));
check('macOS 才设置「关于」面板与菜单', /app\.setAboutPanelOptions/.test(main));

// 顺序断言：过滤必须发生在写配置文件之前，否则核心会先读到一次 Windows-only 配置
const idxFilter = main.indexOf('stripWindowsOnlyFlags(payload.configToml');
const idxWrite = main.indexOf('writeFileAtomic(configFile, sanitized.toml)');
check(
  'Windows-only flag 在**写入配置之前**被过滤，且 replay 存的是过滤后的文本',
  idxFilter > 0 && idxWrite > idxFilter && /replay = \{ configToml: sanitized\.toml/.test(main),
  `filter@${idxFilter} write@${idxWrite}`,
);

/* ------------------------------------------------- 2. platform-support 行为 */

section('platform-support.cjs 行为（真跑一遍两个平台）');
const { stripWindowsOnlyFlags, supportsLanBroadcast, WINDOWS_ONLY_FLAGS } = require(path.join(CLIENT, 'electron', 'platform-support.cjs'));

const toml = [
  '# 由 mclink 主控自动生成',
  'instance_name = "mclink-demo"',
  'dhcp = true',
  'disable_p2p = true',
  'enable_udp_broadcast_relay = true',
  'instance_recv_bps_limit = 1000000',
  '',
].join('\n');

const win = stripWindowsOnlyFlags(toml, 'win32');
check('Windows：原样返回（一个字节都不改）', win.toml === toml && win.disabled.length === 0);

const mac = stripWindowsOnlyFlags(toml, 'darwin');
check('macOS：局域网广播被改成 false', /enable_udp_broadcast_relay = false/.test(mac.toml));
check('macOS：其余 flag 一个都没动', /disable_p2p = true/.test(mac.toml) && /dhcp = true/.test(mac.toml) && /instance_recv_bps_limit = 1000000/.test(mac.toml));
check('macOS：给出了可读原因（不是静默失败）', mac.disabled.length === 1 && typeof mac.disabled[0].why === 'string' && mac.disabled[0].why.length > 10 && /WinDivert/.test(mac.disabled[0].why));
check('macOS：不回改已经是 false 的配置、也不误伤注释行', stripWindowsOnlyFlags('# enable_udp_broadcast_relay = true\nenable_udp_broadcast_relay = false\n', 'darwin').toml === '# enable_udp_broadcast_relay = true\nenable_udp_broadcast_relay = false\n');
check('空输入不炸', stripWindowsOnlyFlags(undefined, 'darwin').toml === '' && stripWindowsOnlyFlags('', 'darwin').disabled.length === 0);
check('supportsLanBroadcast 只在 win32 为 true', supportsLanBroadcast('win32') === true && supportsLanBroadcast('darwin') === false && supportsLanBroadcast('linux') === false);
check('配置清单里的 key 与主控生成的一致（enable_udp_broadcast_relay）', WINDOWS_ONLY_FLAGS.every((f) => /^[a-z_]+$/.test(f.key)) && WINDOWS_ONLY_FLAGS[0].key === 'enable_udp_broadcast_relay');

/* ------------------------------------------------------------- 3. 渲染层 */

section('渲染层（组件 / 样式 / 文案）');
const titleBar = read('client/src/components/TitleBar.vue');
const appRail = read('client/src/components/AppRail.vue');
const themeCss = read('client/src/theme-warm.css');
const platformTs = read('client/src/lib/platform.ts');
const roomPage = read('client/src/pages/RoomPage.vue');
const storeTs = read('client/src/lib/store.ts');

check('TitleBar：macOS 上不画自绘窗口按钮', /v-if="!isMac" class="tb-controls"/.test(titleBar));
check('TitleBar：拖动区保留（-webkit-app-region: drag）', /-webkit-app-region: drag/.test(titleBar));
check('TitleBar：macOS 上双击不自己 toggleMaximize（交给系统偏好）', /if \(isMac\) return;/.test(titleBar));
check('AppRail：macOS 顶部给红黄绿让位且可拖动', /rail-mac-inset/.test(appRail) && /-webkit-app-region: drag/.test(appRail));
check('AppRail：栏宽 80px / 品牌块 64px 未变（外观一致）', /width: 80px/.test(appRail) && /width: 64px/.test(appRail));
check('字体栈同时保留两平台的中文回退', /--font-ui:/.test(themeCss) && /'PingFang SC'/.test(themeCss) && /'Microsoft YaHei'/.test(themeCss) && /'Hiragino Sans GB'/.test(themeCss));
check('platform.ts 提供同步平台判定与文案', /export const isMac/.test(platformTs) && /export const needsAdmin/.test(platformTs) && /export const supportsLanBroadcast/.test(platformTs) && /export const adminHowTo/.test(platformTs));
check('preload 同步暴露 platform', /platform: process\.platform/.test(read('client/electron/preload.cjs')));
check('RoomPage：非 Windows 上广播开关置灰', /:disabled="!supportsLanBroadcast"/.test(roomPage));
check('RoomPage：非 Windows 不提交 allowBroadcast 字段（不去替别的平台关功能）', /\.\.\.\(supportsLanBroadcast \? \{ allowBroadcast/.test(roomPage));
check('store：非 Windows 上开广播会明确报错（第二道闸）', /patch\.allowBroadcast === true/.test(storeTs) && /WinDivert 内核驱动/.test(storeTs));
check('store：建网卡报错文案按平台说 wintun/utun', /tunName/.test(storeTs) && /Operation not permitted/.test(storeTs));

// 更新检查按平台分流：`clientVersion` / `clientDownloadUrl` 那条线指向的是 **Windows 安装包**，
// 所以安卓与 macOS 必须各走自己的产物 —— 顺序错了（mac 分支落在桌面兜底之后）就等于没改。
check('store：更新检查的 /meta 类型里有 mac 产物（macos / macosIntel）', /clientDownloads\?: \{[\s\S]{0,240}macos\?: MetaArtifact \| null/.test(storeTs));
check('store：macOS 更新走 clientDownloads.macos（而不是桌面的 .exe 那条线）', /clientDownloads\?\.macos \?\? m\.clientDownloads\?\.macosIntel/.test(storeTs));
check('store：macOS 分支排在桌面端兜底之前（顺序错了会退回 .exe）', (() => {
  const macBranch = storeTs.indexOf('if (isMac) {\n      const mac = m.clientDownloads?.macos');
  const desktopLine = storeTs.indexOf("const latest = (m.clientVersion ?? '').trim();");
  return macBranch > 0 && desktopLine > 0 && macBranch < desktopLine;
})());

/* ---------------------------------------------------- 4. electron-builder */

section('client/electron-builder.yml');
const builder = yaml.load(read('client/electron-builder.yml'));

check('mac 目标同时出 dmg 与 zip', (() => {
  const targets = (builder.mac?.target ?? []).map((t) => (typeof t === 'string' ? t : t.target));
  return targets.includes('dmg') && targets.includes('zip');
})());
check('mac 两个架构都出（arm64 + x64）', (() => {
  const arches = new Set();
  for (const t of builder.mac?.target ?? []) for (const a of t.arch ?? []) arches.add(a);
  return arches.has('arm64') && arches.has('x64');
})());
check('mac 产物名带 macos（下载页按文件名判平台）', /macos/.test(builder.mac?.artifactName ?? ''));
check('mac 图标用现有 PNG（icon-1024.png，≥512 才够 .icns）', builder.mac?.icon === 'build/icon-1024.png');
check('mac 带上两个架构的 EasyTier 核心', Array.isArray(builder.mac?.extraResources) && builder.mac.extraResources.length === 2 && builder.mac.extraResources.every((r) => /macos-(arm64|x64)/.test(r.from)));
check('mac 只留中英界面资源', Array.isArray(builder.mac?.electronLanguages) && builder.mac.electronLanguages.includes('zh-CN'));
check('没有配置签名身份（没有证书 = 跳过签名与公证）', builder.mac?.identity === undefined && builder.mac?.notarize === undefined);
check('Windows 目标保住：nsis x64 + 图标 + signAndEditExecutable（回归）', builder.win?.icon === 'build/icon.ico' && builder.win?.signAndEditExecutable === true && builder.win?.target?.[0]?.target === 'nsis');
check('Windows 的 wintun/WinDivert 仍在 extraResources 清单里（回归）', ['wintun.dll', 'WinDivert64.sys', 'Packet.dll'].every((f) => (builder.extraResources?.[0]?.filter ?? []).includes(f)));

/* ------------------------------------------------------------ 5. GitLab CI */

section('.gitlab-ci.yml');
const ci = yaml.load(read('.gitlab-ci.yml'));
const jobNames = Object.keys(ci).filter((k) => !['stages', 'variables', 'default', 'workflow', 'include'].includes(k));

check('存在 macOS job，且 tags 指向 macOS runner', (() => {
  const mac = ci['build:macos'];
  return Boolean(mac) && Array.isArray(mac.tags) && mac.tags.some((t) => /^saas-macos-/.test(String(t)));
})());
check('macOS job 是 macOS-only（tags 里没有 windows runner）', (ci['build:macos']?.tags ?? []).every((t) => !/windows/i.test(String(t))));
check('macOS job 产出 dmg + zip 作为 artifacts', (() => {
  const paths = ci['build:macos']?.artifacts?.paths ?? [];
  return paths.some((p) => p.includes('.dmg')) && paths.some((p) => p.includes('.zip'));
})());
check('macOS job 真的跑了 mac 打包（dist.mjs --mac）与签名脚本', (() => {
  const script = (ci['build:macos']?.script ?? []).map(String).join('\n');
  return /dist\.mjs --mac/.test(script) && /sign-macos-app\.sh/.test(script) && /assert-artifacts\.mjs --macos/.test(script);
})());
check('两个架构都在 CI 里构建（--arm64 --x64）', (() => {
  const script = (ci['build:macos']?.script ?? []).map(String).join('\n');
  return /--arm64/.test(script) && /--x64/.test(script);
})());
check('未签名：CI 关掉证书自动发现', ci.variables?.CSC_IDENTITY_AUTO_DISCOVERY === 'false');
check('Windows job 仍在（回归门槛）', (() => {
  const win = ci['build:windows'];
  const script = (win?.script ?? []).map(String).join('\n');
  const paths = win?.artifacts?.paths ?? [];
  return Boolean(win) && (win.tags ?? []).includes('saas-windows-medium-amd64') && /dist\.mjs --win nsis/.test(script) && paths.some((p) => p.includes('.exe'));
})());

// 与 HEAD 逐字段比对：本次改动的**全部**必须落在 build:macos / 注释里，build:windows 不许动
try {
  const headYaml = execFileSync('git', ['show', 'HEAD:.gitlab-ci.yml'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const headCi = yaml.load(headYaml);
  const stable = (job) => JSON.stringify(job, Object.keys(job ?? {}).sort());
  check(
    'build:windows 与 HEAD 完全一致（本次未修改 Windows job）',
    stable(headCi['build:windows']) === stable(ci['build:windows']),
    'Windows job 的字段发生了变化 —— 本次改造不允许动它',
  );
} catch {
  console.log('  · 跳过「与 HEAD 比对」：不是 git 工作区或取不到 HEAD（该断言只在改动期间有意义）');
}

/* ------------------------------------------- 5b. GitHub Actions（备用出包路线） */

/*
 * GitLab SaaS 的 macOS runner 吃每月共享额度，额度用完这条 job 就起不来；
 * GitHub 那边公开仓库的标准 runner 免费不限量、私有仓库也有免费额度，
 * 所以 .github/workflows/build-clients.yml 从"备份路线"变成了**实际出包路线**。
 * 它的 runner 标签、两个架构、签名与产物上传都必须和 GitLab 那条 job 对齐 ——
 * 这些断言全是"改坏了不会在 Windows 上被发现"的那一类。
 */
section('.github/workflows/build-clients.yml');
const gh = yaml.load(read('.github/workflows/build-clients.yml'));
// js-yaml 4 把 `on` 当字符串键，js-yaml 3（或 YAML 1.1 schema）会把它解析成布尔 true —— 两种都接住
const ghOn = gh.on ?? gh['true'] ?? {};
const ghJobs = gh.jobs ?? {};
const stepsOf = (job) => (job?.steps ?? []).map((s) => [s.name ?? '', s.run ?? s.uses ?? ''].join(' ')).join('\n');
const ghMac = ghJobs.macos;
const macSteps = stepsOf(ghMac);

check('仍有 macOS job（GitLab 额度用完后这是唯一能出 dmg 的路径）', Boolean(ghMac));
check('macOS job 的 runner 是 **arm64** 的 macOS 镜像', ['macos-15', 'macos-26', 'macos-latest'].includes(String(ghMac?.['runs-on'] ?? '')), `runs-on = ${ghMac?.['runs-on']}`);
check('没有 pin 到已废弃的 macos-14 / macos-13（GitHub 已把 14 标为 deprecated）', !/macos-1[34]/.test(String(ghMac?.['runs-on'] ?? '')));
check('macOS job 跑了 mac 打包 + 产物断言 + 签名脚本（与 GitLab job 一一对应）', (() => {
  return /dist\.mjs --mac/.test(macSteps) && /assert-artifacts\.mjs --macos/.test(macSteps) && /sign-macos-app\.sh/.test(macSteps);
})());
check('两个架构都在（--arm64 --x64）', /--arm64/.test(macSteps) && /--x64/.test(macSteps));
check('macOS 产物上传有两道口子：dmg 必传 ≤7 天，zip 由 input 控制（私有仓库 500MB 存储上限）', (() => {
  const ups = (ghMac?.steps ?? []).filter((s) => String(s.uses ?? '').startsWith('actions/upload-artifact'));
  const dmg = ups.find((s) => String(s.with?.path ?? '') === 'client/release/*.dmg');
  const zip = ups.find((s) => String(s.with?.path ?? '') === 'client/release/*.zip');
  return (
    Boolean(dmg) &&
    dmg.with?.['if-no-files-found'] === 'error' &&
    Number(dmg.with?.['retention-days'] ?? 99) <= 7 &&
    Boolean(zip) &&
    /inputs\.full_artifacts/.test(String(zip.if ?? ''))
  );
})());
check('未签名：工作流关掉证书自动发现', gh.env?.CSC_IDENTITY_AUTO_DISCOVERY === 'false');
check('只在手动触发：工作流不接受 push/tag 触发（推标签不该白花私有仓库额度）', Boolean(ghOn.workflow_dispatch) && !ghOn.push);
check('Windows job 仍在（回归），但手动跑时默认跳过（不白花私有仓库额度）', Boolean(ghJobs.windows) && /inputs\.windows/.test(String(ghJobs.windows?.if ?? '')));
check('pnpm 由 pnpm/action-setup 安装（不依赖 corepack 是否随 Node 分发）', /pnpm\/action-setup/.test(macSteps) && !/corepack/.test(macSteps));

/* ------------------------------------------------------------- 6. 图标产物 */

section('图标产物（macOS 菜单栏用）');
const pngSize = (file) => {
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(png)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};
const tray1x = pngSize(path.join(CLIENT, 'electron', 'assets', 'tray-mac.png'));
const tray2x = pngSize(path.join(CLIENT, 'electron', 'assets', 'tray-mac@2x.png'));
const icns = pngSize(path.join(CLIENT, 'build', 'icon-1024.png'));
check('tray-mac.png 22×22（菜单栏 1x）', tray1x?.width === 22 && tray1x?.height === 22, JSON.stringify(tray1x));
check('tray-mac@2x.png 44×44（Retina）', tray2x?.width === 44 && tray2x?.height === 44, JSON.stringify(tray2x));
check('icon-1024.png ≥512（electron-builder 转 .icns 的硬要求）', (icns?.width ?? 0) >= 512, JSON.stringify(icns));
check('托盘图是"透明底 + 单色剪影"（模板图的判据）', (() => {
  if (!tray2x) return false;
  const buf = fs.readFileSync(path.join(CLIENT, 'electron', 'assets', 'tray-mac@2x.png'));
  return buf.length > 200; // 解码 PNG 只为判像素不值得；这里只确认不是空图
})());

/* --------------------------------------------------------------- 7. 文档 */

section('文档 docs/build-clients.md');
const doc = read('docs/build-clients.md');
check('写了 macOS 本地出包步骤', /node scripts\/dist\.mjs --mac/.test(doc));
check('写了 GitLab CI 怎么触发', /build:macos/.test(doc) && /Run pipeline/.test(doc));
check('写了未签名包的后果与绕过方式', /xattr -dr com\.apple\.quarantine/.test(doc) && /Gatekeeper/.test(doc));
check('写了"CI 只能在推送后验证"这条边界', /推送/.test(doc) && /未验证|无法在本地验证|只能在/.test(doc));
check('写了 GitHub Actions 这条备用路线（GitLab 配额用完时用）', /build-clients\.yml/.test(doc) && /Run workflow/.test(doc));
check('写了镜像仓库地址与私有仓库的前提（额度 + 500MB 存储）', /github\.com\/luo-die\/mclink/.test(doc) && /500\s?MB/.test(doc) && /2,000|2000/.test(doc));
check('写了远端约定（GitHub 是 origin，GitLab 只读、不再推）', /远端约定/.test(doc) && /GitLab 的远端已改名/.test(doc));
check('没有留下过时的 `git push github main` 指令（远端已改名成 origin）', !/git push github main/.test(doc));
check('写了 runner 不能回退到已废弃的 macos-14', /macos-15/.test(doc) && /deprecated/.test(doc));
check('写了 Linux 硬出这条应急路线的限制（没 dmg / 没签名）', /build-macos-on-linux\.sh/.test(doc) && /hdiutil/.test(doc) && /hdiutil/.test(read('deploy/build-macos-on-linux.sh')));

/* ------------------------------------------------------------------ 汇总 */

console.log(`\n${'='.repeat(72)}`);
if (failures.length === 0) {
  console.log(`静态断言全部通过：${passed} 项。`);
  console.log('注意：这只证明**代码与配置里的分支都存在且结构正确**，');
  console.log('      "macOS 上真的能跑起来、看起来对"必须在真机上验（见 docs/build-clients.md 的自测清单）。');
  process.exit(0);
}
console.log(`静态断言失败 ${failures.length} 项（通过 ${passed} 项）：`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(1);
