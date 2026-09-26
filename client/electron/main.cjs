/**
 * McLink 客户端 —— Electron 主进程（Windows / macOS 共用一份）。
 *
 * 职责划分：
 *   主进程  = 唯一有权启动/停止 easytier-core、读写配置、申请提权、管理托盘的角色
 *   渲染进程 = 纯 UI，通过 preload 暴露的白名单 API 与主进程通信
 *
 * 之所以把核心进程生命周期放在主进程：渲染进程可能被回收/节流，
 * 而虚拟网络必须一直在后台跑着。
 *
 * 平台差异集中在这里，判定一律用 `process.platform`，绝不靠"看起来像"：
 *   · 提权   —— Windows 走 UAC（Start-Process -Verb RunAs），macOS 走 osascript 授权框；
 *               两者都需要，因为建虚拟网卡（wintun / utun）都要管理员/root。
 *   · 窗口   —— Windows 用无边框 + 自绘按钮；macOS 用 hiddenInset + 系统红黄绿按钮
 *               （见 createWindow 的注释：这是 mac 用户的肌肉记忆，自绘三个圆点会很"假"）。
 *   · 菜单栏 —— 只有 macOS 建原生菜单（⌘Q/⌘W/⌘,/⌘R…）；Windows 侧保持原样不动。
 *   · 托盘   —— Windows 用 icon.ico；macOS 的菜单栏要 18px 的模板图（.ico 在 mac 上读不出来）。
 *   · 局域网广播 —— 依赖 WinDivert（Windows 内核驱动），macOS 上明确关闭并写明原因。
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage, nativeTheme, Notification } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { decideElevation, buildElevateCommand } = require('./elevation.cjs');
const { normalizeCloseAction, resolveCloseChoice } = require('./close-action.cjs');
const { stripWindowsOnlyFlags } = require('./platform-support.cjs');
const { tcpPingAll } = require('./tcping.cjs');

const isDev = !app.isPackaged;
/** 平台判定只认这一处：散落的 `process.platform === ...` 是分支写反的温床 */
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

/**
 * Windows 的 toast 通知要求进程有一个 **AppUserModelId**，而且它必须与开始菜单快捷方式
 * 上的那个一致；不一致或不设置时，`new Notification().show()` 会**静默什么都不显示**
 * （不抛错、也不触发 failed —— 这是最容易误判成"代码没跑"的一种失败）。
 *
 * 取值必须与 electron-builder.yml 的 `appId` 相同：NSIS 安装器创建的快捷方式用的就是它。
 * 也因为这个原因，**免安装的 `--win dir` 产物在没装过的情况下可能弹不出 toast**
 * （没有那条快捷方式），装机版才稳 —— 这一点写在 docs/troubleshooting.md 里。
 */
const APP_USER_MODEL_ID = 'com.mclink.client';
if (isWin) app.setAppUserModelId(APP_USER_MODEL_ID);
/** 只有显式设置了该变量（scripts/dev.mjs 会设置）才去连开发服务器 */
const DEV_URL = process.env.MCLINK_CLIENT_DEV_URL || '';
const DEV_FALLBACK_URL = 'http://127.0.0.1:5174';

/**
 * 把老数据目录里**属于我们自己的**文件搬过来。
 *
 * 背景：早期 `client/package.json` 只有 `name: "@mclink/client"`，Electron 就拿包名当
 * 应用名，数据落在 `%APPDATA%\@mclink\client`（一个带 scope 的怪目录）。
 * 现在补了 `productName: "McLink"`，位置变成 `%APPDATA%\McLink`。
 *
 * 平台无关：路径全部来自 `app.getPath('appData')`，macOS 上自动是
 * `~/Library/Application Support`（旧目录 `~/Library/Application Support/@mclink/client`），
 * 所以这段代码在两个平台上都成立，不需要分支。
 *
 * 为什么只搬 `easytier/` 与 `logs/`，而不是整个目录改名：
 *   实测 Electron 在进入 main.js **之前**就已经把新的 userData 目录建好并打开了
 *   （里面已有 lockfile、Preferences、Cache 等 Chromium 正在使用的文件），
 *   所以「目标目录还不存在才改名」这条判断永远不会成立；
 *   而去动一个已经打开的 profile 目录，轻则缓存失效重则 profile 损坏。
 *   登录令牌存在 Local Storage 里，只能让玩家重新登录一次——这个代价可以接受。
 *
 * 必须在 DATA_DIR/LOG_DIR 这些常量**之前**执行：它们都是从 userData 算出来的。
 */
function migrateLegacyDataDir() {
  const moved = [];
  try {
    const legacy = path.join(app.getPath('appData'), '@mclink', 'client');
    const current = app.getPath('userData');
    if (path.resolve(legacy) === path.resolve(current)) return moved;
    if (!fs.existsSync(legacy)) return moved;
    for (const name of ['easytier', 'logs']) {
      const from = path.join(legacy, name);
      const to = path.join(current, name);
      // 目标已存在就说明新目录已经在用了，不再覆盖
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.renameSync(from, to);
      moved.push(name);
    }
  } catch {
    // 迁移失败不是致命错误：大不了重新登录一次，绝不能因此起不来
  }
  return moved;
}

const migratedDataDirs = migrateLegacyDataDir();

/* ------------------------------------------------------------------ 路径 */

/**
 * 平台专属的 vendor 子目录名。
 *
 * 为什么需要它：`vendor/easytier` 里那批**无扩展名**的二进制是 **Linux** 版
 * （主控服务端在用），macOS 上按老逻辑会去执行这个 Linux ELF —— 必然失败。
 * 所以 macOS 的二进制单独放在 `macos-arm64/`、`macos-x64/` 子目录里，
 * 运行时按当前架构选；Windows/Linux 继续用平铺的那份。
 */
function platformVendorSubdir() {
  if (!isMac) return null;
  return process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
}

function resolveVendorDir() {
  const bases = app.isPackaged
    ? [path.join(process.resourcesPath, 'vendor', 'easytier')]
    : [
        path.join(__dirname, '..', '..', 'vendor', 'easytier'),
        path.join(__dirname, '..', 'vendor', 'easytier'),
      ];
  const sub = platformVendorSubdir();
  for (const base of bases) {
    // macOS 优先用架构专属子目录；找不到再退回平铺目录（便于本机开发时复用一份）
    if (sub) {
      const scoped = path.join(base, sub);
      if (fs.existsSync(scoped)) return scoped;
    }
    if (fs.existsSync(base)) return base;
  }
  return bases[0];
}

const VENDOR_DIR = resolveVendorDir();
const CORE_BIN = path.join(VENDOR_DIR, isWin ? 'easytier-core.exe' : 'easytier-core');
const CLI_BIN = path.join(VENDOR_DIR, isWin ? 'easytier-cli.exe' : 'easytier-cli');
const DATA_DIR = path.join(app.getPath('userData'), 'easytier');
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const MAX_LOG_LINES = 1500;

/* -------------------------------------------------------------- 运行状态 */

let mainWindow = null;
let tray = null;
let quitting = false;

/** @type {{ child: import('node:child_process').ChildProcess|null, configFile: string|null, args: string[], rpcPortal: string|null, startedAt: string|null, lastError: string|null, state: 'stopped'|'starting'|'running'|'error' }} */
const core = {
  child: null,
  configFile: null,
  args: [],
  rpcPortal: null,
  startedAt: null,
  lastError: null,
  state: 'stopped',
};

/** 内存环形日志，供界面展示 */
const coreLogs = [];
/** 待恢复的启动参数（崩溃自动重启用） */
let replay = null;

/**
 * 串行化「启动/停止核心进程」。
 *
 * 连接房间（`core:start`）与「应用 ACL 后重启核心」（applyAcl 的回退路径）是两条
 * 独立入口，都会调用 startCore()；而 startCore() 内部要先 await stopCore()
 * （最长等 5 秒）。两条入口交错时的实际时序是：A 停 → B 停 → A 起 → B 起，
 * 第二个 easytier-core 抢不到监听端口，直接 failed to listen（os error 10048）
 * 退出——玩家侧看到的就是「显示连上了，但一直进不去房间」。
 *
 * 这里用一条 Promise 链把启停排队，保证同一时刻只有一次启停在进行；
 * 链条本身不会因为某一次失败而断开。
 */
let coreOpChain = Promise.resolve();
/** 正在按计划重启核心：用于区分「我们主动停的」和「核心自己崩了」 */
let coreRestarting = false;

function withCoreLock(task) {
  const run = coreOpChain.then(task, task);
  coreOpChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 往渲染层发消息 —— 必须先确认窗口**和它的 webContents** 都还活着。
 *
 * 为什么不能只写 `mainWindow?.webContents.send(...)`：
 * 退出流程里 easytier-core 比窗口晚一步退出，它的 close 回调仍然会走到
 * logLine() / setState()。这时 mainWindow 引用还在（不是 null），但 webContents
 * 已经销毁，`.send()` 直接抛 "Object has been destroyed" —— 表现就是
 * **关客户端时弹一个主进程 JS 错误框**（实测截图：main.cjs:162 logLine）。
 * 可选链只挡得住 null，挡不住"已被销毁的对象"。
 */
function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function logLine(line, stream = 'stdout') {
  const entry = { ts: new Date().toISOString(), stream, line };
  coreLogs.push(entry);
  if (coreLogs.length > MAX_LOG_LINES) coreLogs.splice(0, coreLogs.length - MAX_LOG_LINES);
  sendToRenderer('core:log', entry);
}

function setState(state, error) {
  core.state = state;
  if (error !== undefined) core.lastError = error;
  const payload = coreStatus();
  sendToRenderer('core:status', payload);
  updateTray();
  return payload;
}

function coreStatus() {
  return {
    state: core.state,
    pid: core.child?.pid ?? null,
    startedAt: core.startedAt,
    lastError: core.lastError,
    configFile: core.configFile,
    args: core.args,
    rpcPortal: core.rpcPortal,
    elevated: isElevated(),
    /** 不够权限时的可读原因（受限令牌 / 未提权）；够权限时为 null */
    elevationReason: elevationStatus().reason,
    /** 可执行文件路径与所在目录：提权失败时界面要能带用户去"右键 → 以管理员身份运行" */
    exePath: process.execPath,
    exeDir: path.dirname(process.execPath),
    coreBin: CORE_BIN,
    coreBinExists: fs.existsSync(CORE_BIN),
    cliBinExists: fs.existsSync(CLI_BIN),
  };
}

/* -------------------------------------------------------------- 提权检测 */

let elevationCache = null;

/**
 * 提权状态：要回答的是"**能不能建虚拟网卡**"，而不是"像不像管理员"。
 *
 * 用户实测踩到的坑：`runas /trustlevel:0x20000` 启动时，进程的完整性级别**仍是 High**
 * （`whoami /groups` 里能看到 S-1-16-12288），但令牌是**受限令牌**：Administrators 组
 * 变成 deny-only，建 wintun 虚拟网卡照样失败（核心退出码 1）。
 *
 * **第一版修错了方向**：我去 `whoami /groups` 里找 RESTRICTED(S-1-5-12) —— 但受限 SID
 * 属于令牌的"受限 SID 列表"，`whoami` 根本不列它，于是判定依旧返回"已提权"、弹窗不出现
 * （用户复测反馈"还是不行，没有提示无权限"）。
 *
 * 所以现在改成**直接问 Windows 权威答案**：`WindowsPrincipal.IsInRole(Administrator)`。
 * UAC 过滤后的令牌与 runas 受限令牌都会返回 false —— 这正是"我能不能行使管理员权限"。
 * whoami 那份输出只用来**解释原因**（是受限令牌、还是被 UAC 过滤、还是压根没提权）。
 */
function elevationStatus() {
  /**
   * macOS/Linux：判断"当前是不是 root"。
   * 原来是 `return true`（当作"非 Windows 不需要提权"），但 macOS 上创建 utun
   * 虚拟网卡同样需要 root —— 一律返回 true 会让界面显示"已管理员运行"，
   * 实际却没权限，玩家看到的是核心起不来又没有任何提示。
   */
  if (!isWin) {
    const ok = typeof process.getuid !== 'function' || process.getuid() === 0;
    return { ok, restricted: false, reason: ok ? null : '需要以 root 运行：macOS/Linux 创建虚拟网卡要 root 权限' };
  }
  if (elevationCache !== null) return elevationCache;
  /**
   * 调试开关：本机（开发/验证环境）常常本来就是管理员，这条 UI 路径没法自然复现。
   * `MCLINK_FORCE_UNELEVATED=1` 让判定结果假装"没有权限"，用来验证弹窗与文案。
   */
  if (process.env.MCLINK_FORCE_UNELEVATED === '1') {
    elevationCache = { ok: false, restricted: false, reason: '（调试）MCLINK_FORCE_UNELEVATED=1：模拟未提权' };
    return elevationCache;
  }
  let groups = '';
  try {
    // 只用来解释"为什么没权限"，判定本身不依赖它
    const res = spawnSync('whoami', ['/groups'], { encoding: 'utf8', windowsHide: true });
    groups = res.stdout || '';
  } catch {
    groups = '';
  }
  const restricted = /S-1-5-12\b/.test(groups);
  const high = /S-1-16-12288/.test(groups);
  /**
   * 判定本身是纯函数（`electron/elevation.cjs`）：四种令牌组合都能离线断言，
   * 不必再靠"在真机上碰运气" —— 这条判定的前两版都错在这里。
   */
  const adminIsInRole = realAdminRights();
  const verdict = decideElevation({ adminIsInRole, high, restricted });
  elevationCache = { ok: verdict.ok, restricted, reason: verdict.reason };
  /**
   * 判定依据写进应用日志（结果会缓存，所以只写一次）。
   * 这条日志是给"玩家说没提示权限"这类反馈准备的：日志里能直接看到
   * IsInRole 问了什么、答案是什么、完整性级别如何，而不必远程猜。
   */
  try {
    logLine(
      `权限判定：IsInRole(Administrator)=${adminIsInRole ?? '探测失败'} · 完整性级别=${high ? 'High' : '非 High'} · 受限标记=${restricted ? '有' : '无'} → ${verdict.ok ? '可用' : `不可用（${verdict.reason}）`}`,
      verdict.ok ? 'info' : 'stderr',
    );
  } catch {
    /* 日志失败不影响判定 */
  }
  return elevationCache;
}

/**
 * 权威判定：当前进程**能不能行使管理员权限**。
 *
 * 返回 true / false / null（探测失败）。用 .NET 的 WindowsPrincipal 而不是解析 whoami：
 *   · 提权进程       → true
 *   · 普通用户       → false
 *   · UAC 过滤的令牌 → false（Administrators 是 deny-only）
 *   · runas 受限令牌 → false（同上）
 * 慢一点（一次性 ~300ms，结果会缓存）但结论可靠：这正是"能不能建网卡"的答案。
 */
function realAdminRights() {
  try {
    const res = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[bool](New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
    );
    const out = (res.stdout || '').trim().toLowerCase();
    if (out === 'true') return true;
    if (out === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

function isElevated() {
  return elevationStatus().ok;
}

/**
 * 取核心日志末尾最有价值的一行。
 *
 * 核心退出时我们只拿得到退出码，真正的原因（wintun 建网卡失败、端口被占、密钥无效…）
 * 只写在它自己的 `core-*.log` 里 —— 玩家报"退出码 1"时，光看码是没法排查的。
 * 优先取最后一条 ERROR/panic，其次取最后一行非空文本。
 */
function lastCoreLogLine(logFile, maxBytes = 8192) {
  try {
    const size = fs.statSync(logFile).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(logFile, 'r');
    try {
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf
      .toString('utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const errorLine = [...lines].reverse().find((l) => /ERROR|error|panic|failed|拒绝/i.test(l));
    return (errorLine ?? lines[lines.length - 1] ?? '').slice(0, 300);
  } catch {
    return '';
  }
}

/* ------------------------------------------------- 提权偏好（自动请求 UAC） */

/**
 * 提权偏好存在 userData 下的一个小 JSON 里。
 *
 * 为什么要记状态：Windows 上创建虚拟网卡必须要管理员，玩家不该自己去翻
 * 「右键 → 以管理员身份运行」。所以默认在启动时**自动请求一次 UAC**；
 * 但如果玩家点了「否」，我们就不能每次开客户端都再弹一次（那就成了骚扰），
 * 于是记下上次请求时间，几天内不再自动弹，手动按钮仍然可用。
 */
const PREFS_FILE = path.join(app.getPath('userData'), 'client-prefs.json');
/** 玩家拒绝过之后，多久内不再自动请求 */
const ELEVATION_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * GPU 加速的**自动降级**。
 *
 * 背景（真实日志）：
 *   ERROR:gpu_process_host.cc(976) GPU process launch failed: error_code=18
 *   FATAL:gpu_data_manager_impl_private.cc(423) GPU process isn't usable. Goodbye.
 * 这是 Electron 的 GPU 子进程起不来（虚拟机/远程桌面没有可用 GPU、显卡驱动异常、
 * 或被安全软件拦截），Chromium 会**直接致命退出** —— 玩家看到的是"客户端打不开"。
 *
 * 为什么不让玩家自己去设置里关：这种情况应用根本进不去，设置页也就点不到。
 * 所以做成自愈：只要观测到 GPU 进程挂过，就写标记；**下次启动自动改用软件渲染**。
 * disableHardwareAcceleration 必须在 app ready 之前调用，所以这段放在模块顶层。
 *
 * 另一个入口是环境变量 MCLINK_DISABLE_GPU=1，方便客服远程指导（比重装快）。
 */
const softwareRendering = readPrefs().disableGpu === true || process.env.MCLINK_DISABLE_GPU === '1';
if (softwareRendering) {
  app.disableHardwareAcceleration();
  console.warn('[gpu] 已启用软件渲染（之前观测到 GPU 进程异常，或 MCLINK_DISABLE_GPU=1）');
}
function writePrefs(patch) {
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify({ ...readPrefs(), ...patch }, null, 2), 'utf8');
  } catch {
    /* 存不下就只在本次会话生效 */
  }
}

/** 是否该在启动时自动请求提权 */
function shouldAutoElevate() {
  // Windows 与 macOS 都需要管理员才能建虚拟网卡（wintun / utun）；Linux 一般由用户态处理
  if (!isWin && !isMac) return false;
  if (isElevated()) return false;
  // 开发模式（electron .）不自动提权：否则每次改代码重启都要点一次 UAC
  if (!app.isPackaged && process.env.MCLINK_AUTO_ELEVATE !== '1') return false;
  const prefs = readPrefs();
  if (prefs.autoElevate === false) return false;
  const last = Number(prefs.elevationAskedAt ?? 0);
  return Date.now() - last > ELEVATION_RETRY_MS;
}

/**
 * 以管理员身份重新启动自己（会弹 UAC）。
 *
 * 两个容易踩的点：
 *   1. 必须**先释放单实例锁再退出**。提权出来的新进程要拿同一把锁，
 *      如果老进程还握着，新进程会立刻 `app.quit()` —— 结果就是"点了提权，窗口全没了，
 *      却什么都没起来"。（手点按钮那条路径也是同样的竞态，这里一并修掉。）
 *   2. 玩家在 UAC 上点「否」时 `Start-Process -Verb RunAs` 退出码非 0，
 *      这不是错误：照常以普通权限继续跑（能登录、能建房，只是虚拟网卡建不起来）。
 */
function requestElevation() {
  /**
   * macOS：用 osascript 的 `with administrator privileges` 重新拉起自己。
   * 和 Windows 一样，macOS 建 utun 也需要 root；没有这一步，mac 用户会卡在
   * "核心起不来"且完全不知道要做什么。
   * 打包版直接执行 .app 内的可执行文件；开发版带上入口参数。
   */
  if (isMac) {
    writePrefs({ elevationAskedAt: Date.now() });
    return new Promise((resolve) => {
      try {
        const exe = process.execPath;
        const args = app.isPackaged ? [] : [path.join(__dirname, '..')];
        // osascript 里所有路径都要转义成 AppleScript 字符串
        const quoted = [`"${exe.replace(/"/g, '\\"')}"`, ...args.map((a) => `"${a.replace(/"/g, '\\"')}"`)].join(' ');
        const script = `do shell script "${quoted} > /dev/null 2>&1 &" with administrator privileges`;
        const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
        child.on('close', (code) => {
          if (code === 0) {
            quitting = true;
            app.releaseSingleInstanceLock();
            app.quit();
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: `提权启动被取消或失败（osascript 退出码 ${code}）` });
          }
        });
        child.on('error', (err) => resolve({ ok: false, error: err.message }));
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
  }
  if (!isWin) return Promise.resolve({ ok: false, error: '该平台不需要提权' });
  const exe = process.execPath;
  const args = app.isPackaged ? [] : [path.join(__dirname, '..')];
  /**
   * 组装 Start-Process 参数。
   *
   * 踩过的坑（用户实测："以管理员身份重启这个按钮按了没用"）：
   * 打包版没有额外参数，而老代码**无条件**拼了 `-ArgumentList `（后面空着），
   * PowerShell 直接报 `Missing an argument for parameter 'ArgumentList'` 并以 1 退出 ——
   * 于是点了按钮既不弹 UAC、界面上也毫无反应（错误只写进了 state.lastError，弹窗里看不到）。
   * 开发版因为带着入口参数，这条路一直没被走到，所以之前的验证也没发现。
   */
  const command = buildElevateCommand(exe, args);
  // 记下这次请求的时间：玩家点了「否」也不会每次都再弹
  writePrefs({ elevationAskedAt: Date.now() });

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        logLine(`提权请求：${result.ok ? '已启动管理员实例，本进程退出' : `失败 —— ${result.error}`}`, result.ok ? 'info' : 'stderr');
      } catch {
        /* 日志失败不影响结果 */
      }
      resolve(result);
    };
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
      });
      let stderr = '';
      child.stderr?.on('data', (d) => {
        stderr += String(d);
      });
      // 兜底超时：授权框没弹出来时不能让按钮永远停在"正在重启…"
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 可能已退出 */
        }
        done({ ok: false, error: '提权请求超时（系统授权框没有出现）' });
      }, 60_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          quitting = true;
          app.releaseSingleInstanceLock();
          app.quit();
          done({ ok: true });
          return;
        }
        const text = stderr.replace(/\s+/g, ' ').trim();
        // 玩家在授权框上点「否」时说"已取消"：这是正常选择，不该显示成故障
        const canceled = /canceled|cancelled|取消/i.test(text);
        done({
          ok: false,
          error: canceled
            ? '你在系统授权框里点了取消：客户端继续以普通权限运行，联机不可用'
            : `提权启动失败（退出码 ${code}）${text ? `：${text.slice(0, 200)}` : ''}`,
        });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        done({ ok: false, error: err.message });
      });
    } catch (err) {
      done({ ok: false, error: err.message });
    }
  });
}

/* ---------------------------------------------- 关闭窗口时的询问（ask 模式） */

/**
 * 正在等界面答复的关闭请求。
 *
 * 为什么要有这层状态：close 事件是同步的，而"问用户"要异步等答复 ——
 * 所以先 preventDefault 拦下来，再让渲染进程弹窗，等它通过 IPC 回话。
 * 8 秒兜底：界面卡住/窗口没了就按"最小化到托盘"处理，
 * 绝不把用户锁在"点了 X 但什么都没发生"。界面弹出后会立刻回一个 ack，
 * 我们会撤掉这个兜底计时器（否则用户盯着弹窗看 8 秒会被莫名其妙收进托盘）。
 */
let closeAsk = null;

function askCloseAction() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // 连窗口都没有，问不了 —— 直接退出，别留一个看不见的进程
    quitting = true;
    app.quit();
    return;
  }
  if (closeAsk) return; // 已经在问了，别重复弹
  const timer = setTimeout(() => {
    closeAsk = null;
    mainWindow?.hide();
  }, 8000);
  closeAsk = { timer };
  mainWindow.webContents.send('app:ask-close');
}

/* ------------------------------------------------------------ 核心进程 */

/**
 * 清理上次异常退出留下的 easytier-core 孤儿进程。
 *
 * 客户端被任务管理器强杀、或自己崩掉时，子进程不会跟着消失：它会继续占着虚拟
 * 网卡与监听端口，于是下一次启动直接 failed to listen（os error 10048）。
 * 单实例锁保证同一时刻只有一个 McLink，所以这些残留一定是上次的。
 *
 * 判定条件必须**同时**满足两条，这是实测踩出来的：
 *   1. 可执行文件在本应用的 vendor 目录里 —— 用户机器上可能另装着自己玩的 EasyTier；
 *   2. 命令行里出现本客户端的数据目录 —— 开发机上主控中继用的是同一份
 *      `vendor/easytier/easytier-core.exe`（它的配置文件在 server/data 下），
 *      只看第 1 条会把主控自己的中继一起杀掉。
 * 两条都满足时，进程必然是「本客户端上次留下的」。
 */
function cleanupOrphanCores() {
  const ownExe = path.resolve(VENDOR_DIR).toLowerCase();
  const ownData = path.resolve(DATA_DIR).toLowerCase();
  try {
    if (isWin) {
      /**
       * 用 WMI 查进程路径与命令行。
       *
       * 为什么不直接 `taskkill /IM easytier-core.exe`：那会连用户自己装的 EasyTier 一起杀。
       *
       * 为什么里面套一层 try/catch 与 `@()`：实测这台机器上 Get-CimInstance
       * 会偶发 `远程过程调用失败 (0x800706BE)`，此时命令整体失效、stdout 为空，
       * 清理就静默失效了（第一次测孤儿清理就是这么失败了一次）。
       * 所以 WMI 失败时退回旧的 Get-WmiObject，并把结果强制成数组。
       */
      const script = [
        "$ErrorActionPreference='SilentlyContinue'",
        "try { $p = @(Get-CimInstance Win32_Process -Filter \"Name='easytier-core.exe'\" -ErrorAction Stop) }",
        // 注意用换行而不是 '; ' 拼接：`try { } ; catch { }` 在 PowerShell 里是语法错误
        'catch { $p = @(Get-WmiObject Win32_Process -Filter "Name=\'easytier-core.exe\'") }',
        "if ($null -eq $p -or $p.Count -eq 0) { '[]' }",
        'else { $p | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress }',
      ].join('\n');
      let res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 12000,
      });
      // 偶发的进程创建/管道失败再试一次；两次都不行就放弃，绝不能影响启动
      if (res.error || res.status !== 0) {
        logLine(`清理残留进程：第一次查询失败（${res.error?.message ?? `退出码 ${res.status}`}），重试一次`, 'stderr');
        res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 12000,
        });
      }
      if (res.error) {
        logLine(`清理残留进程失败：${res.error.message}`, 'stderr');
        return 0;
      }
      if (res.status !== 0) {
        logLine(`清理残留进程失败：PowerShell 退出码 ${res.status}`, 'stderr');
        return 0;
      }
      const raw = (res.stdout || '').trim();
      if (!raw) return 0;
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      let killed = 0;
      for (const row of rows) {
        const exe = typeof row?.ExecutablePath === 'string' ? path.resolve(row.ExecutablePath).toLowerCase() : '';
        const cmd = typeof row?.CommandLine === 'string' ? row.CommandLine.toLowerCase() : '';
        const pid = Number(row?.ProcessId);
        if (!exe.startsWith(ownExe) || !cmd.includes(ownData)) continue;
        if (!Number.isInteger(pid) || pid <= 0) continue;
        try {
          process.kill(pid);
          killed += 1;
        } catch {
          /* 可能刚好自己退了 */
        }
      }
      return killed;
    }
    /**
     * 非 Windows 分支（macOS / Linux）：用 POSIX 的 pkill 按命令行匹配。
     * 同样要求"路径在本应用 vendor 下 **且** 命令行里出现本客户端的数据目录"，
     * 只不过程序名与匹配工具不同（macOS 没有 WMI，也没有 taskkill）。
     */
    const res = spawnSync('pkill', ['-f', `easytier-core.*${DATA_DIR}`], { windowsHide: true, timeout: 5000 });
    return res.status === 0 ? 1 : 0;
  } catch (err) {
    // 清理是尽力而为，失败不能影响启动；但要留下线索，否则「没清理掉」永远查不出原因
    logLine(`清理残留进程失败：${err.message}`, 'stderr');
    return 0;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/** 端口没抢到时最多试几次（第 2 次之前会先清残留、再等端口释放） */
const MAX_START_ATTEMPTS = 2;
/** easytier-core 抢不到监听端口时打在日志里的样子 */
const BIND_FAILURE_RE = /failed to listen|Address already in use|os error 10048|os error 98|WSAEADDRINUSE/i;

function detectBindFailure(logFile) {
  try {
    const match = fs.readFileSync(logFile, 'utf8').match(BIND_FAILURE_RE);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * 启动 easytier-core（对外入口，串行执行）。
 * @param {{ configToml: string, launchArgs?: string[], instanceName?: string }} payload
 */
function startCore(payload) {
  return withCoreLock(() => startCoreInner(payload, 1));
}

/**
 * 真正干活的启动流程。只允许被 startCore() 或它自己的重试调用——
 * 直接调用会绕过串行队列，正是我们要消灭的那种交错。
 */
async function startCoreInner(payload, attempt) {
  if (core.child) await stopCore();

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const configFile = path.join(DATA_DIR, `${(payload.instanceName || 'mclink').replace(/[^\w.-]/g, '_')}.toml`);
  /**
   * 落盘前按平台过滤掉 Windows-only 的 flag（当前只有「局域网广播直通」）。
   *
   * 为什么在**写文件之前**做：写进去再改等于让核心先读到一次无效配置；
   * 而且 `replay`（崩溃自动重启用）保存的必须是**同一个**过滤后的文本，
   * 否则每次自动重启都会把 WinDivert 那行又带回来 —— 就成了"偶发失效"。
   */
  const sanitized = stripWindowsOnlyFlags(payload.configToml, process.platform);
  writeFileAtomic(configFile, sanitized.toml);

  const args = (payload.launchArgs ?? ['-c', '%CONFIG%']).map((a) => (a === '%CONFIG%' ? configFile : a));
  if (!fs.existsSync(CORE_BIN)) {
    return setState('error', `找不到 easytier-core：${CORE_BIN}`);
  }

  replay = { configToml: sanitized.toml, launchArgs: payload.launchArgs, instanceName: payload.instanceName };
  core.configFile = configFile;
  core.args = args;
  core.rpcPortal = pickRpcPortal(args);
  core.lastError = null;
  setState('starting');

  // 明确告诉玩家"这个功能为什么没了"，而不是让他在「多人游戏」列表里干等
  for (const item of sanitized.disabled) {
    logLine(`已按平台关闭「${item.feature}」（${item.key}）：${item.why}`, 'info');
  }

  const logFile = path.join(LOG_DIR, `core-${Date.now()}.log`);
  const fd = fs.openSync(logFile, 'a');
  let child;
  try {
    // 不用 'pipe'：既避免管道缓冲区写满导致卡死，也便于事后排查
    child = spawn(CORE_BIN, args, {
      cwd: DATA_DIR,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      detached: false,
    });
  } catch (err) {
    fs.closeSync(fd);
    return setState('error', `启动失败：${err.message}`);
  }
  core.child = child;
  logLine(`$ ${path.basename(CORE_BIN)} ${args.join(' ')}`, 'info');
  logLine(`配置文件：${configFile}`, 'info');
  logLine(`运行日志：${logFile}`, 'info');

  child.on('error', (err) => {
    core.lastError = err.message;
    logLine(`进程错误：${err.message}`, 'stderr');
    setState('error', err.message);
  });

  child.on('close', (code) => {
    core.child = null;
    core.startedAt = null;
    logLine(`easytier-core 退出，退出码 ${code}`, 'info');
    if (quitting) {
      setState('stopped');
      return;
    }
    // 主动重启期间（端口重试）既不该报「意外退出」，也不该再排队一次自动重启
    if (coreRestarting) return;
    /**
     * 报错要带"原因"，不能只给退出码：
     * 核心把真正的原因写在自己的日志里（wintun 建网卡失败、端口被占…），
     * 而权限不足时我们也知道该怎么办 —— 一并写进这条消息，玩家不用去翻日志。
     */
    const tail = lastCoreLogLine(logFile);
    const elevation = elevationStatus();
    const hint = elevation.ok ? '' : `。${elevation.reason}`;
    setState('error', `easytier-core 意外退出（退出码 ${code}）${tail ? `：${tail}` : ''}${hint}`);
    // 崩溃后自动重试一次，避免网络因为偶发问题一直断着
    if (replay) {
      setTimeout(() => {
        if (!core.child && replay && !quitting && !coreRestarting) {
          logLine('尝试自动重启 easytier-core…', 'info');
          startCore(replay).catch(() => {});
        }
      }, 4000);
    }
  });

  // EasyTier 没有就绪信号，用短延迟把「能起来」与「立刻崩溃」区分开
  await delay(1400);
  if (!core.child || quitting) return coreStatus();

  const bindError = detectBindFailure(logFile);
  if (bindError) {
    if (attempt < MAX_START_ATTEMPTS) {
      logLine(`监听端口没能占上（${bindError}），清理残留后重试…`, 'stderr');
      coreRestarting = true;
      try {
        await stopCore();
        await delay(1500);
      } finally {
        coreRestarting = false;
      }
      return startCoreInner(payload, attempt + 1);
    }
    logLine(`监听端口仍然被占用（${bindError}）：通常是残留进程或其它虚拟网络软件占着它。`, 'stderr');
    coreRestarting = true;
    try {
      await stopCore();
    } finally {
      coreRestarting = false;
    }
    return setState('error', '监听端口被占用，虚拟网络无法建立');
  }

  core.startedAt = new Date().toISOString();
  setState('running');
  return coreStatus();
}

function pickRpcPortal(args) {
  const idx = args.indexOf('-r');
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

/**
 * `ps -o time=` 的输出 → 秒数。
 * 形如 `0:01.23`（分:秒）、`1:02:03`（时:分:秒），从右往左按 60 进制累加即可。
 * 解析不出来就返回 undefined —— 宁可没有这个数字，也不要给界面一个 NaN。
 */
function parseCpuTime(text) {
  const parts = String(text ?? '').trim().split(':');
  if (parts.length === 0 || parts.length > 3) return undefined;
  let seconds = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value)) return undefined;
    seconds = seconds * 60 + value;
  }
  return seconds;
}

async function stopCore() {
  const child = core.child;
  replay = null;
  if (!child) {
    setState('stopped');
    return coreStatus();
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 可能已退出 */
      }
      resolve();
    }, 5000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
  core.child = null;
  setState('stopped');
  return coreStatus();
}

/* ------------------------------------------------------- easytier-cli */

function runCli(args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (!core.rpcPortal) {
      resolve({ ok: false, error: 'easytier-core 未运行，无法查询' });
      return;
    }
    if (!fs.existsSync(CLI_BIN)) {
      resolve({ ok: false, error: `找不到 easytier-cli：${CLI_BIN}` });
      return;
    }
    const full = ['-p', core.rpcPortal, '-o', 'json', ...args];
    const child = spawn(CLI_BIN, full, { windowsHide: true });
    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error: `easytier-cli 超时（${timeoutMs}ms）` });
    }, timeoutMs);

    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8').trim();
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (code !== 0) {
        resolve({ ok: false, error: stderr || stdout || `退出码 ${code}` });
        return;
      }
      if (stdout.length === 0) {
        resolve({ ok: true, data: null });
        return;
      }
      try {
        resolve({ ok: true, data: JSON.parse(stdout) });
      } catch {
        resolve({ ok: false, error: `输出无法解析为 JSON：${stdout.slice(0, 200)}` });
      }
    });
  });
}

/** 探测当前 easytier-cli 是否支持运行时热替换 ACL（2.6.4 尚无此子命令） */
let aclSetSupport = null;
async function supportsAclSet() {
  if (aclSetSupport !== null) return aclSetSupport;
  const res = await runCli(['acl', '--help']);
  aclSetSupport = res.ok && /(^|\s)set(\s|$)/.test(JSON.stringify(res.data ?? '') + (res.error ?? ''));
  if (!aclSetSupport) {
    // --help 在 JSON 模式下可能解析失败，退化为直接尝试一次极小的 set
    const probe = await runCli(['acl', 'set', '[acl.acl_v1]'], 6000);
    aclSetSupport = probe.ok;
  }
  return aclSetSupport;
}

/**
 * 应用房主 ACL。
 * 支持 `acl set` 时热更新；不支持时写回配置并重启核心（房主会短暂断线约 2 秒）。
 */
async function applyAcl(aclToml) {
  if (!core.child) return { ok: false, error: 'easytier-core 未运行' };
  if (await supportsAclSet()) {
    const file = path.join(DATA_DIR, `acl-${Date.now()}.toml`);
    fs.writeFileSync(file, aclToml, 'utf8');
    const res = await runCli(['acl', 'set', `@${file}`], 15000);
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
    if (res.ok) return { ok: true, mode: 'hot' };
    return { ok: false, error: res.error ?? 'acl set 失败' };
  }

  // 回退路径：把 ACL 追加进配置后重启
  if (!core.configFile) return { ok: false, error: '没有可用的配置文件' };
  const current = fs.readFileSync(core.configFile, 'utf8');
  const stripped = current.replace(/\n\[acl\.acl_v1\][\s\S]*$/m, '\n');
  writeFileAtomic(core.configFile, `${stripped.trimEnd()}\n\n${aclToml.trim()}\n`);
  const payload = replay ? { ...replay, configToml: fs.readFileSync(core.configFile, 'utf8') } : null;
  if (!payload) return { ok: false, error: '无法恢复启动参数' };
  await startCore(payload);
  return { ok: true, mode: 'restart' };
}

/* ------------------------------------------------------------- 窗口/托盘 */

/**
 * 窗口标题栏：**两个平台两种做法**，这是本文件里最需要解释的一处取舍。
 *
 * Windows：无边框 + 自绘标题栏。
 *   为什么不用系统标题栏：Windows 原生的那条灰白标题栏与这套暖墨/琥珀的界面
 *   完全是两种语言，摆在一起像两个软件拼起来的。参照 MCTier 的做法自绘一条，
 *   把窗口控制、连接状态和身份信息合并成一行。
 *   保留的关键能力（去掉 frame 容易顺手丢掉这些）：
 *     · `thickFrame` 默认 true → 窗口仍可拖拽改变大小，Win+方向键仍能贴边
 *     · 双击标题栏最大化/还原，由渲染层发 IPC 实现（TitleBar.vue 的 dblclick）
 *     · `titleBarStyle: 'hidden'` 让系统只保留阴影与圆角，不给标题栏
 *
 * macOS：`titleBarStyle: 'hiddenInset'` + **系统红黄绿按钮**（不要 frame: false）。
 *   三个理由，都是"mac 用户会立刻发现不对"的那一类：
 *     1. 红黄绿是系统级控件：位置、悬停时的符号、⌥ 键把绿灯变成"缩放"、
 *        以及"绿灯=全屏"这些都是系统行为，自绘圆点只能模仿外观、模仿不了行为；
 *     2. 关闭语义不同：Windows 上点 X 是"收进托盘"，macOS 上点红点是"关掉这个窗口"
 *        （应用继续活着），系统按钮天然表达了这个意思，自绘按钮需要额外解释；
 *     3. 可访问性：VoiceOver 认得出系统按钮，认不出我们的 div。
 *   代价只有一处：左上角 ~70px 被系统占用，所以 AppRail 顶部要留出空白
 *   （`--rail-top-inset`，见 AppRail.vue）—— 自绘标题栏与状态文字照旧保留，
 *   只是把"窗口控制"这一小块交还给系统。
 */
/**
 * 窗口默认尺寸：**横向宽窗**。
 *
 * 原来是 460×720 的窄竖窗（单列）。改成 940×580 是因为外壳换成了
 * 「左图标栏 + 右侧一列」的横向骨架 —— 这套骨架在窄窗里会把链路牌挤成两行、
 * 底部动作条也没地方放。最小值守住 780×520：再窄下去图标栏与内容会开始打架。
 */
const WINDOW_DEFAULTS = {
  width: 940,
  height: 580,
  minWidth: 780,
  minHeight: 520,
  maxWidth: 1400,
  /**
   * 窗口底色只能在原生层给（这时还读不到 CSS 变量）：
   * 取 tokens.css 里 --ink-900 / --paper 的同一对值，跟随系统亮暗，
   * 免得亮色系统上先闪一下暖墨底。
   */
  backgroundColor: nativeTheme.shouldUseDarkColors ? '#121110' : '#f5f0e7',
};

/**
 * 平台专属的窗口选项。
 *
 * `frame` 必须显式写：默认 true —— 在 Windows 上漏写这一条会变成"系统标题栏 + 自绘标题栏"
 * 两条叠着（历史上就是这么错的），在 macOS 上写 false 又会把红黄绿一起干掉。
 */
function platformWindowOptions() {
  if (isMac) {
    return {
      frame: true,
      titleBarStyle: 'hiddenInset',
      /**
       * 红黄绿的位置：默认 inset 是 (20, 20) 左右，与 52px 的标题条相比偏上。
       * 这里把 y 提到 17，让三个按钮与标题条的文字在视觉上同一条水平线 ——
       * 不改 x：横向位置属于系统版式，动它看起来就不像原生应用了。
       */
      trafficLightPosition: { x: 18, y: 17 },
      // macOS 的菜单栏永远在屏幕顶部，窗口级菜单条这个概念不存在
      autoHideMenuBar: false,
    };
  }
  return {
    frame: false,
    titleBarStyle: 'hidden',
    // Windows/Linux：默认菜单没有用（我们自绘），藏起来但保留 Alt 唤出
    autoHideMenuBar: true,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    ...platformWindowOptions(),
    show: false,
    // 两种平台都可调整大小；macOS 上可最大化 = 绿灯可用（缩放）
    resizable: true,
    maximizable: true,
    title: 'McLink',
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 关掉后台节流：最小化到托盘后心跳与 WebSocket 仍要正常工作
      backgroundThrottling: false,
    },
  });

  loadRenderer(mainWindow);

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  /** 最大化状态变化时通知渲染层，好把"最大化/还原"图标切换过来 */
  const pushMaximized = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      sendToRenderer('win:maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', pushMaximized);
  mainWindow.on('unmaximize', pushMaximized);

  mainWindow.on('close', (event) => {
    /**
     * 关闭窗口的行为由偏好决定（`closeAction`）：
     *   · ask（默认）—— 拦下来，让界面弹「彻底退出 / 最小化到托盘」（可记住选择）
     *   · tray        —— 直接收进托盘（老行为）
     *   · quit        —— 直接退出
     * 以前是无条件收进托盘、**没有任何提示**：玩家以为退出了，其实进程还在后台跑、联机也没断。
     *
     * macOS 上「关闭窗口」与「退出应用」是两件事，这里必须分得干净：
     *   · 红点 / ⌘W → 走的就是这条 close（macOS 的惯例是"关窗不退出"，
     *     所以界面上的文案是「隐藏窗口」，不是「最小化到托盘」——见 CloseConfirm.vue）；
     *   · ⌘Q / 菜单「退出 McLink」→ app.quit()，先经过 before-quit（把 quitting 置 true），
     *     于是**不会**被下面的 ask 分支拦下来 —— macOS 用户按 ⌘Q 就是要退出，
     *     再弹一个"要退出吗"会被当成应用有毛病。
     */
    if (quitting) return;
    const action = normalizeCloseAction(readPrefs().closeAction);
    if (action === 'quit') {
      /**
       * 这里必须显式 app.quit()。
       * `window-all-closed` 被我们改成了空实现（为了"关掉窗口后留在托盘"），
       * 所以只让窗口关掉的话，进程会**继续留在托盘里**——用户以为彻底退出了，
       * 其实还有一个看不见的 McLink 在后台，正是这次要修的那种毛病。
       * （实测：打包版 closeAction=quit 时窗口没了、进程仍在，测试就是这么抓到的。）
       * 用 setImmediate 让当前这次 close 先走完，避免在 close 处理里重入 quit。
       */
      quitting = true;
      setImmediate(() => app.quit());
      return;
    }
    event.preventDefault();
    if (action === 'tray') {
      mainWindow?.hide();
      return;
    }
    askCloseAction();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * 决定渲染进程加载什么。
 * 优先级：显式开发服务器 > 已构建的 dist/index.html > 开发默认端口。
 * 之前用 `!app.isPackaged` 当判据是错的：直接 `electron .` 跑未打包代码时
 * 也会被当成开发模式，结果去连根本没有启动的 Vite，白屏。
 */function loadRenderer(win) {
  if (DEV_URL) {
    win.loadURL(DEV_URL);
    return;
  }
  const built = path.join(__dirname, '..', 'dist', 'index.html');
  if (fs.existsSync(built)) {
    win.loadFile(built);
    return;
  }
  if (isDev) {
    logLine('未找到已构建的渲染产物，回退到开发服务器 5174。请先运行 pnpm --filter @mclink/client build', 'info');
    win.loadURL(DEV_FALLBACK_URL);
    return;
  }
  // 兜底页：颜色写死是有意的——这时渲染产物就没了，读不到 CSS 变量
  win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      '<body style="background:#121110;color:#f5f0e7;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">' +
        '<div style="text-align:center"><h2 style="font-weight:600">渲染资源缺失</h2>' +
        '<p style="color:#bdb3a4">请重新安装客户端。</p></div></body>',
    )}`,
  );
}

function showMainWindow() {
  mainWindow?.show();
  mainWindow?.focus();
}

/**
 * 窗口/托盘图标。
 *
 * 为什么必须分平台：`nativeImage.createFromPath()` 只在 Windows 上认 `.ico`，
 * 在 macOS 上给它一个 .ico 会返回**空图像** —— 托盘图标变成一块看不见的空白
 * （功能还在，只是没人找得到菜单栏上的它，关闭窗口后就"找不回应用"了）。
 * 所以 macOS 用 `electron/assets/tray-mac.png`（由 `pnpm icons` 生成的不透明剪影，
 * 交给系统按菜单栏明暗自动反色），开发模式下退回 build/icon.png。
 */
function appIconPath() {
  const candidates = isMac
    ? [
        // 打包后/开发时都能命中：electron/assets 会被打进 asar
        path.join(__dirname, 'assets', 'tray-mac.png'),
        // 开发模式下直接跑仓库里的 build/（打包时这个目录会被 electron-builder 排除，别依赖它）
        path.join(__dirname, '..', 'build', 'icon.png'),
        path.join(__dirname, '..', '..', 'client', 'build', 'icon.png'),
      ]
    : [
        // 打包后/开发时都能命中：electron/assets 会被打进 asar
        path.join(__dirname, 'assets', 'icon.ico'),
        // 开发模式下直接跑仓库里的 build/（打包时这个目录会被 electron-builder 排除，别依赖它）
        path.join(__dirname, '..', 'build', 'icon.ico'),
        path.join(__dirname, '..', '..', 'client', 'build', 'icon.ico'),
      ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return undefined;
}

function createTray() {
  const iconPath = appIconPath();
  let image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (isMac && !image.isEmpty()) {
    /**
     * macOS 的菜单栏高度是 22px；直接把 256px 的图塞进去会被系统压缩得发糊。
     * 缩到 18px（模板图按 1x/2x 各自渲染，Retina 上是 36px）。
     * `setTemplateImage` 只对剪影图设置：让系统按菜单栏明暗自动涂黑/涂白，
     * 深色菜单栏上不会变成一块看不见的黑方块。
     */
    image = image.resize({ width: 18, height: 18 });
    if (path.basename(iconPath).startsWith('tray-mac')) image.setTemplateImage(true);
  }
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('McLink 《我的世界》联机');
  tray.on('double-click', () => {
    showMainWindow();
  });
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const label =
    core.state === 'running' ? '已连接' : core.state === 'starting' ? '正在连接…' : core.state === 'error' ? '连接异常' : '未连接';
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `McLink —— ${label}`, enabled: false },
      { type: 'separator' },
      {
        label: '显示主窗口',
        click: () => {
          showMainWindow();
        },
      },
      {
        label: core.child ? '断开虚拟网络' : '重新连接',
        click: () => {
          if (core.child) stopCore();
          else if (replay) startCore(replay);
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

/* ------------------------------------------------------------ macOS 菜单栏 */

/**
 * 菜单栏（**只在 macOS 上建**）。
 *
 * 为什么 macOS 必须有：菜单栏是 mac 应用的"命令行" —— 没有它，⌘Q / ⌘H / ⌘M /
 * ⌘W / ⌘, 这些系统级习惯全都无处可去，用户会当成"这个应用没做完"。
 * Electron 会给一个默认菜单，但那是英文的 Electron 名字与默认项，与「暖纸台」不是一套语言。
 *
 * 为什么 Windows 上**不建**：Windows 侧现在是无边框窗口 + 自绘标题栏，
 * 窗口菜单条是多余的一层；改动它等于改 Windows 的现有行为，不在本次范围内。
 * （保持现状：不调用 setApplicationMenu，Electron 的默认菜单在 autoHideMenuBar 下不可见。）
 */
function sendMenuCommand(command) {
  /**
   * 走渲染层而不是直接操作窗口：菜单是"导航到设置页"这种**业务意图**，
   * 而哪个页面怎么切是渲染层的事（App.vue 的 goto）。主进程只负责转发。
   */
  sendToRenderer('app:menu-command', command);
  showMainWindow();
}

/**
 * 重新加载界面（⌘R）。
 *
 * 为什么要拦一下：渲染层的会话状态（当前房间、票据、成员）**只在内存里**，
 * 而虚拟网络的进程在主进程里照旧跑着 —— 直接 reload 会让界面回到"没进房"的样子，
 * 但核心还连着，心跳停了、房间成员过期，表现就是"我明明连着，界面说我没连"。
 * 所以正在联机时先问一句：要么取消，要么**先断开**再重新加载，不留半吊子状态。
 */
async function reloadWindowSafely(ignoreCache = false) {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (core.child) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['取消', '断开并重新加载'],
      defaultId: 0,
      cancelId: 0,
      message: '虚拟网络正在运行',
      detail:
        '重新加载界面会与正在运行的虚拟网络失去同步：界面会忘记当前房间与成员，需要重新进房。\n' +
        '要先断开虚拟网络再重新加载吗？',
    });
    if (response !== 1) return;
    await stopCore().catch(() => {});
  }
  if (ignoreCache) win.webContents.reloadIgnoringCache();
  else win.webContents.reload();
}

function buildApplicationMenu() {
  if (!isMac) return;
  const appName = app.name || 'McLink';
  const template = [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `关于 ${appName}` },
        { type: 'separator' },
        /**
         * ⌘, 是 macOS 上"打开偏好设置"的固定手势，缺了它用户会去 Dock 图标上找。
         * 我们的设置页在渲染层，所以这里只是个转发。
         */
        { label: '设置…', accelerator: 'Command+,', click: () => sendMenuCommand('settings') },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${appName}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        // ⌘Q：真正的退出。会先走 before-quit，所以不会撞上"关闭窗口"的询问
        { role: 'quit', label: `退出 ${appName}` },
      ],
    },
    {
      /**
       * 编辑菜单：mac 上这几个 role 不只是"给输入框用的"，
       * 没有它们，⌘C/⌘V 在系统层面就没有对应的命令项（复制粘贴会失效）。
       */
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'delete', label: '删除' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载界面', accelerator: 'Command+R', click: () => void reloadWindowSafely(false) },
        { label: '强制重新加载界面', accelerator: 'Shift+Command+R', click: () => void reloadWindowSafely(true) },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' },
        { type: 'separator' },
        /**
         * ⌘W = 关闭这一个窗口（走既有的关闭偏好：询问 / 隐藏 / 退出）。
         * 与 ⌘Q 的区别必须留着：mac 用户靠这两项区分"收起界面"和"退出应用"。
         */
        { role: 'close', label: '关闭窗口' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------- 系统通知（有人发消息） */

/**
 * 通知的实况：给界面（设置页提示"系统不支持通知"）与自动化验收用。
 *
 * 为什么记账放在主进程：渲染层只知道"我请求弹一条"，**到底弹出去没有只有主进程知道**
 * （`Notification.isSupported()`、'show' 与 'failed' 事件都在这一侧）。
 * 排查"为什么没弹"时，这几个数字就是全部证据。
 */
const notifyStats = {
  requested: 0,
  shown: 0,
  failed: 0,
  lastError: null,
  supported: null,
};

function notificationsSupported() {
  if (notifyStats.supported === null) {
    try {
      notifyStats.supported = Notification.isSupported();
    } catch {
      notifyStats.supported = false;
    }
  }
  return notifyStats.supported;
}

/**
 * 用户点了通知之后要做的事：**把窗口叫回来**（收在托盘/菜单栏里也拉起来），
 * 再告诉渲染层"跳到这个房间"。
 *
 * 为什么抽成函数：自动化验收要断言这条落点（点了通知到底有没有回到房间页），
 * 而系统通知的"点击"没法用脚本模拟 —— 测试走的是**同一个函数**
 * （notify:simulateClick，只在 MCLINK_TEST_HOOKS=1 时注册）。
 */
function handleNotificationClick(roomId) {
  showMainWindow();
  sendToRenderer('app:notify-click', { roomId: roomId ?? null });
}

/**
 * 弹一条系统通知（Windows = toast，macOS = 通知中心，都由 Electron 的 Notification 承担）。
 *
 * 两端真正不同的地方只有两处：
 *   · Windows：toast 依赖 AppUserModelId（见文件顶部的常量），并且用 .ico 当图标；
 *   · macOS：通知中心一律用**应用自己的图标**，`icon` 参数会被忽略 —— 所以我们不传，
 *     免得哪天它被用上时显示成 22px 的黑色剪影（tray-mac.png）。
 *     macOS 还会在用户拒绝通知权限时**静默丢弃**：这时 'failed' 不一定触发，
 *     所以界面上不能承诺"一定弹"（设置页写的是"会尽量提醒"）。
 */
function showMessageNotification(payload) {
  notifyStats.requested += 1;
  if (!notificationsSupported()) {
    notifyStats.lastError = '当前系统不支持通知';
    return { ok: false, error: notifyStats.lastError, ...notifyStats };
  }
  const title = String(payload?.title ?? 'McLink').slice(0, 120);
  const body = String(payload?.body ?? '').slice(0, 300);
  const roomId = payload?.roomId ? String(payload.roomId) : null;
  try {
    const options = { title, body, silent: false };
    if (isWin) {
      const icon = appIconPath();
      if (icon) options.icon = icon;
    }
    const notification = new Notification(options);
    notification.on('show', () => {
      notifyStats.shown += 1;
    });
    notification.on('failed', (_event, error) => {
      notifyStats.failed += 1;
      notifyStats.lastError = String(error ?? '未知原因');
      logLine(`系统通知发送失败：${notifyStats.lastError}`, 'stderr');
    });
    notification.on('click', () => handleNotificationClick(roomId));
    notification.show();
    return { ok: true, ...notifyStats };
  } catch (err) {
    notifyStats.failed += 1;
    notifyStats.lastError = err.message;
    logLine(`系统通知发送失败：${err.message}`, 'stderr');
    return { ok: false, error: err.message, ...notifyStats };
  }
}

function registerIpc() {
  /* ------------------------------------------------ 自绘标题栏的窗口控制
   * 注意：macOS 上这三个按钮**不显示**（系统红黄绿接管，见 platformWindowOptions），
   * 但这条 IPC 桥保留着 —— 一是 Windows 侧照旧用，二是将来若要给 mac 加快捷键入口
   * 不必再改 preload 契约。渲染层只是不渲染按钮而已。
   */
  const withMain = (fn) => () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    return fn(mainWindow);
  };
  ipcMain.handle('win:minimize', withMain((w) => (w.minimize(), true)));
  ipcMain.handle(
    'win:toggleMaximize',
    withMain((w) => {
      if (w.isMaximized()) w.unmaximize();
      else w.maximize();
      return w.isMaximized();
    }),
  );
  ipcMain.handle('win:isMaximized', withMain((w) => w.isMaximized()));
  /**
   * 关闭按钮 = 收进托盘（与点系统关闭按钮一致），不直接退出。
   * 真正的退出在托盘菜单里，避免误点把正在跑的房间网络一起关掉。
   */
  ipcMain.handle(
    'win:close',
    withMain((w) => {
      w.close();
      return true;
    }),
  );
  ipcMain.handle('win:hide', withMain((w) => (w.hide(), true)));
  ipcMain.handle('win:hideToTray', withMain((w) => (w.hide(), true)));

  /* ------------------------------------------------ 关闭窗口时的询问 */
  /**
   * 界面已经弹出了询问框 → 撤掉主进程那边的兜底计时器。
   * 不撤的话：用户盯着弹窗看超过 8 秒，窗口会被莫名收进托盘。
   */
  ipcMain.handle('app:closeAskOpened', () => {
    if (closeAsk?.timer) {
      clearTimeout(closeAsk.timer);
      closeAsk.timer = null;
    }
    return { ok: Boolean(closeAsk) };
  });

  /** 用户在询问框里做出的选择 */
  ipcMain.handle('app:closeDecision', (_e, payload) => {
    if (!closeAsk) return { ok: false, error: '没有待处理的关闭请求' };
    if (closeAsk.timer) clearTimeout(closeAsk.timer);
    closeAsk = null;
    const { action, persist } = resolveCloseChoice(payload?.action, payload?.remember === true);
    if (persist) writePrefs({ closeAction: persist });
    if (action === 'quit') {
      quitting = true;
      app.quit();
    } else if (action === 'tray') {
      mainWindow?.hide();
    }
    // action === 'cancel'：什么都不做，窗口保持原样
    return { ok: true, action, closeAction: normalizeCloseAction(readPrefs().closeAction) };
  });

  /** 设置页里直接改默认的关闭行为 */
  ipcMain.handle('app:setCloseAction', (_e, value) => {
    const action = normalizeCloseAction(value);
    writePrefs({ closeAction: action });
    return { ok: true, closeAction: action };
  });
  /**
   * GPU 子进程挂掉时写标记：下一次启动就会走软件渲染。
   * 注意这个事件在**致命退出之前**也会触发，所以标记能在本次就落盘。
   */
  app.on('child-process-gone', (_event, details) => {
    if (details.type !== 'GPU') return;
    const reason = String(details.reason ?? 'unknown');
    logLine(`GPU 进程异常退出（${reason}），下次启动将改用软件渲染`, 'stderr');
    writePrefs({ disableGpu: true, gpuGoneAt: Date.now() });
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
    dataDir: DATA_DIR,
    logDir: LOG_DIR,
    vendorDir: VENDOR_DIR,
    coreBin: CORE_BIN,
    cliBin: CLI_BIN,
    elevated: isElevated(),
    /** 不够权限时的可读原因：让界面能说清"为什么起不来"，而不是只报一个退出码 */
    elevationReason: elevationStatus().reason,
    /** 可执行文件位置：自动提权失败时，界面要能带用户去"右键 → 以管理员身份运行" */
    exePath: process.execPath,
    exeDir: path.dirname(process.execPath),
    /** 启动时是否会自动请求管理员权限（设置页的开关读它） */
    autoElevate: readPrefs().autoElevate !== false,
    /** 有人在房间说话时弹系统通知（默认开）；关掉后一条都不弹 */
    notifyMessages: readPrefs().notifyMessages !== false,
    /** 当前系统能不能弹通知（macOS 用户可能关掉了通知权限；Windows 可能是精简系统） */
    notificationsSupported: notificationsSupported(),
    /** 关闭窗口时的行为：ask（默认，关的时候问一次）/ tray（收进托盘）/ quit（直接退出） */
    closeAction: normalizeCloseAction(readPrefs().closeAction),
    /** true = 正在用软件渲染（此前观测到 GPU 进程异常，或设了 MCLINK_DISABLE_GPU=1） */
    softwareRendering,
    hostname: os.hostname(),
  }));

  /**
   * TCP 延迟探测（建房页选节点时用）—— tcping，**不是 ICMP**。
   *
   * 判定与实现都放在 `electron/tcping.cjs`（纯逻辑，可离线断言，见
   * `client/scripts/verify-tcping.mjs`）；这里只做 IPC 边界，不掺业务。
   */
  ipcMain.handle('net:tcping', (_event, targets) => tcpPingAll(targets));
  ipcMain.handle('app:freePort', () => freePort());
  ipcMain.handle('app:openPath', (_e, target) => shell.openPath(String(target)));
  ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(String(url)));

  ipcMain.handle('app:relaunchElevated', () => requestElevation());

  /* ------------------------------------------------ 有人发消息时的系统通知 */
  /**
   * 渲染层决定"该弹了"之后调这里 —— 判定不在这里做：判定要读的
   * "窗口聚焦吗 / 正看着那个房间吗"只有渲染层知道，主进程只负责把它弹出去。
   */
  ipcMain.handle('notify:show', (_e, payload) => showMessageNotification(payload));
  /** 通知实况（设置页提示 + 自动化验收） */
  ipcMain.handle('notify:state', () => ({
    supported: notificationsSupported(),
    appUserModelId: isWin ? APP_USER_MODEL_ID : null,
    ...notifyStats,
  }));
  ipcMain.handle('app:setNotifyMessages', (_e, enabled) => {
    const value = enabled !== false;
    writePrefs({ notifyMessages: value });
    return { ok: true, notifyMessages: value };
  });
  /**
   * 自动化专用：走**同一个** handleNotificationClick。
   * 只在 MCLINK_TEST_HOOKS=1 时注册 —— 正常启动下这条 IPC 根本不存在，
   * 免得有人能凭空让窗口跳来跳去。
   */
  if (process.env.MCLINK_TEST_HOOKS === '1') {
    ipcMain.handle('notify:simulateClick', (_e, roomId) => {
      handleNotificationClick(roomId ? String(roomId) : null);
      return { ok: true };
    });
  }

  ipcMain.handle('app:setAutoElevate', (_e, enabled) => {
    const value = enabled !== false;
    writePrefs({ autoElevate: value });
    return { ok: true, autoElevate: value };
  });

  ipcMain.handle('core:start', async (_e, payload) => {
    try {
      return await startCore(payload ?? {});
    } catch (err) {
      return setState('error', err.message);
    }
  });
  // 停也进同一个队列：否则「连接还在排队」时点断开，会把刚起来的核心立刻掐掉
  ipcMain.handle('core:stop', () => withCoreLock(() => stopCore()));
  ipcMain.handle('core:status', () => coreStatus());
  ipcMain.handle('core:logs', (_e, limit) => coreLogs.slice(-(Number(limit) || 400)));
  ipcMain.handle('core:resourceUsage', () => {
    const pid = core.child?.pid;
    if (!pid) return null;
    try {
      if (isWin) {
        const res = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `Get-Process -Id ${pid} | Select-Object -Property WorkingSet64,CPU | ConvertTo-Json -Compress`,
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 5000 },
        );
        return res.stdout ? JSON.parse(res.stdout) : null;
      }
      /**
       * macOS / Linux：没有 PowerShell。用 POSIX 的 ps 取同一对事实，并**归一成同一形状**
       * （WorkingSet64 字节 / CPU 秒），免得调用方还要再判一次平台：
       *   rss  = 常驻内存，单位 KB；time = 累计 CPU 时间，形如 `1:02.34` 或 `1:02:03`。
       */
      const res = spawnSync('ps', ['-o', 'rss=,time=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
      const line = (res.stdout || '').trim();
      if (!line) return null;
      const [rssKb, cpuTime] = line.split(/\s+/);
      const rss = Number(rssKb);
      if (!Number.isFinite(rss)) return null;
      return { WorkingSet64: rss * 1024, CPU: parseCpuTime(cpuTime) };
    } catch {
      return null;
    }
  });

  ipcMain.handle('core:applyAcl', async (_e, aclToml) => {
    try {
      return await applyAcl(String(aclToml ?? ''));
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('core:peers', async () => {
    const res = await runCli(['peer', 'list']);
    return res;
  });

  ipcMain.handle('core:cli', async (_e, args) => runCli(Array.isArray(args) ? args.map(String) : []));

  /*
   * 原生确认框 —— **现在只作为兜底**，界面统一走应用内弹层。
   *
   * 渲染层的调用点已经全部改掉（原来在 pages/RoomPage.vue 的退出房间 / 关闭房间 /
   * 轮换密钥 / 踢出成员，以及 components/ChatPanel.vue 的删除消息），现在都走
   * src/lib/confirm.ts 的 confirmInApp() + src/components/ConfirmDialog.vue。
   *
   * 为什么不直接删掉这条桥：`window.mclink.confirm` 是主进程对外暴露的能力，
   * 属于接口契约 —— 删了以后哪里想再用（例如将来某个原生才能问的问题）还得加回来；
   * 而且 preload.cjs 里也一并暴露着。留着它 = 留一条能用的退路，不影响任何行为。
   */
  ipcMain.handle('dialog:confirm', async (_e, { title, message, detail }) => {
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['取消', '确定'],
      defaultId: 1,
      cancelId: 0,
      title: title ?? '请确认',
      message: message ?? '',
      detail: detail ?? '',
    });
    return res.response === 1;
  });
}

/* ------------------------------------------------------------------ 启动 */

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (migratedDataDirs.length > 0) {
      logLine(`已从旧数据目录迁移：${migratedDataDirs.join('、')}`, 'info');
    }
    /**
     * 菜单栏与「关于」面板都只在 macOS 上做（Windows 侧保持现状，见 buildApplicationMenu）。
     * 顺序无所谓，但要在窗口之前建好：macOS 上菜单栏是应用级的，
     * 窗口出现时它就该已经在屏幕顶部了。
     */
    if (isMac) {
      app.setAboutPanelOptions({
        applicationName: 'McLink',
        applicationVersion: app.getVersion(),
        version: app.getVersion(),
        copyright: 'McLink · 基于 EasyTier 的《我的世界》联机平台',
      });
      buildApplicationMenu();
    }
    registerIpc();
    createWindow();
    createTray();
    if (!fs.existsSync(CORE_BIN)) {
      logLine(`警告：未找到 easytier-core（${CORE_BIN}）。请运行 pnpm fetch:easytier 或重新安装客户端。`, 'stderr');
    }
    if (!isElevated()) {
      logLine(
        isMac
          ? '当前不是以 root 运行：创建虚拟网卡（utun）会失败，请使用「以管理员身份重启」。'
          : '当前未以管理员身份运行：创建虚拟网卡（TUN）会失败，请使用「以管理员身份重启」。',
        'stderr',
      );
    }
    /**
     * 等窗口画出来之后再清残留：Windows 上查进程要起一次 PowerShell（几百毫秒），
     * macOS 上是 pkill（很快）。放在启动路径上会让双击图标到出现界面的那一下变慢。
     * 1.2 秒后执行，早于任何人能点完「连接」。
     */
    setTimeout(() => {
      const orphans = cleanupOrphanCores();
      if (orphans > 0) logLine(`已清理上一次残留的 easytier-core 进程 ${orphans} 个`, 'stderr');
    }, 1200);

    /**
     * 自动请求管理员权限。
     *
     * Windows 上创建虚拟网卡（wintun）必须要管理员，而玩家不该自己去翻
     * 「右键 → 以管理员身份运行」。所以默认在启动时自动弹一次 UAC：
     *   · 点「是」→ 提权后的新实例接管（老实例会先释放单实例锁再退出）；
     *   · 点「否」→ 照常以普通权限运行，7 天内不再自动弹（设置页可以彻底关掉，手动按钮仍在）。
     * 开发模式不自动弹，免得每次改代码重启都要点 UAC（要测就设 MCLINK_AUTO_ELEVATE=1）。
     *
     * macOS 走同一条逻辑，只是"系统授权框"换成了 osascript 的 administrator privileges
     * （见 requestElevation）：utun 同样要 root，没有这一步 mac 用户会卡在
     * "核心起不来、又没有任何提示"上。
     */
    if (shouldAutoElevate()) {
      logLine(isMac ? '当前不是以 root 运行：正在请求管理员授权（创建虚拟网卡需要）…' : '未以管理员身份运行：正在请求提权（创建虚拟网卡需要）…', 'info');
      setTimeout(() => {
        void requestElevation().then((res) => {
          if (!res.ok) {
            logLine(`未提权：${res.error}。仍可登录与建房，但虚拟网卡建不起来；可在设置页手动重试。`, 'stderr');
          }
        });
      }, 800);
    }
  });

  app.on('window-all-closed', () => {
    /**
     * 不随窗口关闭退出，两个平台都是**故意的**（这正是 `closeAction` 偏好在管的事）：
     *   · Windows：收进托盘继续跑 —— 关掉窗口不等于断掉联机；
     *   · macOS：关闭窗口后应用继续活着（Dock 图标还在，⌘Q 才退出），
     *     这是 mac 的系统惯例，`activate` 事件会把窗口叫回来。
     */
  });

  app.on('before-quit', async () => {
    quitting = true;
    await stopCore().catch(() => {});
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
}
