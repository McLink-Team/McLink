/**
 * McLink Windows 客户端 —— Electron 主进程。
 *
 * 职责划分：
 *   主进程  = 唯一有权启动/停止 easytier-core、读写配置、申请提权、管理托盘的角色
 *   渲染进程 = 纯 UI，通过 preload 暴露的白名单 API 与主进程通信
 *
 * 之所以把核心进程生命周期放在主进程：渲染进程可能被回收/节流，
 * 而虚拟网络必须一直在后台跑着。
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage, nativeTheme } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');

const isDev = !app.isPackaged;
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
  if (process.platform !== 'darwin') return null;
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
const CORE_BIN = path.join(VENDOR_DIR, process.platform === 'win32' ? 'easytier-core.exe' : 'easytier-core');
const CLI_BIN = path.join(VENDOR_DIR, process.platform === 'win32' ? 'easytier-cli.exe' : 'easytier-cli');
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

function logLine(line, stream = 'stdout') {
  const entry = { ts: new Date().toISOString(), stream, line };
  coreLogs.push(entry);
  if (coreLogs.length > MAX_LOG_LINES) coreLogs.splice(0, coreLogs.length - MAX_LOG_LINES);
  mainWindow?.webContents.send('core:log', entry);
}

function setState(state, error) {
  core.state = state;
  if (error !== undefined) core.lastError = error;
  const payload = coreStatus();
  mainWindow?.webContents.send('core:status', payload);
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
    coreBin: CORE_BIN,
    coreBinExists: fs.existsSync(CORE_BIN),
    cliBinExists: fs.existsSync(CLI_BIN),
  };
}

/* -------------------------------------------------------------- 提权检测 */

let elevatedCache = null;

function isElevated() {
  /**
   * macOS/Linux：判断"当前是不是 root"。
   * 原来是 `return true`（当作"非 Windows 不需要提权"），但 macOS 上创建 utun
   * 虚拟网卡同样需要 root —— 一律返回 true 会让界面显示"已管理员运行"，
   * 实际却没权限，玩家看到的是核心起不来又没有任何提示。
   */
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function') return process.getuid() === 0;
    return true;
  }
  if (elevatedCache !== null) return elevatedCache;
  try {
    // whoami /groups 里出现 High Mandatory Level 即视为已提权
    const res = spawnSync('whoami', ['/groups'], { encoding: 'utf8', windowsHide: true });
    elevatedCache = /S-1-16-12288/.test(res.stdout || '');
  } catch {
    elevatedCache = false;
  }
  return elevatedCache;
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
  if (process.platform !== 'win32' && process.platform !== 'darwin') return false;
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
  if (process.platform === 'darwin') {
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
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: '该平台不需要提权' });
  const exe = process.execPath;
  const args = app.isPackaged ? [] : [path.join(__dirname, '..')];
  const command = `Start-Process -FilePath '${exe}' -ArgumentList ${args
    .map((a) => `'${a}'`)
    .join(',')} -Verb RunAs`;
  // 记下这次请求的时间：玩家点了「否」也不会每次都再弹
  writePrefs({ elevationAskedAt: Date.now() });

  return new Promise((resolve) => {
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true });
      child.on('close', (code) => {
        if (code === 0) {
          quitting = true;
          app.releaseSingleInstanceLock();
          app.quit();
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: `提权启动被取消或失败（退出码 ${code}）` });
        }
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
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
    if (process.platform === 'win32') {
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
  writeFileAtomic(configFile, payload.configToml);

  const args = (payload.launchArgs ?? ['-c', '%CONFIG%']).map((a) => (a === '%CONFIG%' ? configFile : a));
  if (!fs.existsSync(CORE_BIN)) {
    return setState('error', `找不到 easytier-core：${CORE_BIN}`);
  }

  replay = { configToml: payload.configToml, launchArgs: payload.launchArgs, instanceName: payload.instanceName };
  core.configFile = configFile;
  core.args = args;
  core.rpcPortal = pickRpcPortal(args);
  core.lastError = null;
  setState('starting');

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
    setState('error', `easytier-core 意外退出（退出码 ${code}）`);
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
 * 窗口做成**无边框 + 自绘标题栏**。
 *
 * 为什么不用系统标题栏：Windows 原生的那条灰白标题栏与这套暖墨/琥珀的界面
 * 完全是两种语言，摆在一起像两个软件拼起来的。参照 MCTier 的做法自绘一条，
 * 把窗口控制、连接状态和身份信息合并成一行。
 *
 * 保留的关键能力（去掉 frame 容易顺手丢掉这些）：
 *   · `thickFrame` 默认 true → 窗口仍可拖拽改变大小，Win+方向键仍能贴边
 *   · 双击标题栏最大化/还原，由渲染层发 IPC 实现
 *   · `titleBarStyle: 'hidden'` 让系统只保留阴影与圆角，不给标题栏
 */
const WINDOW_DEFAULTS = {
  width: 460,
  height: 720,
  minWidth: 400,
  minHeight: 640,
  maxWidth: 1100,
  /**
   * 窗口底色只能在原生层给（这时还读不到 CSS 变量）：
   * 取 tokens.css 里 --ink-900 / --paper 的同一对值，跟随系统亮暗，
   * 免得亮色系统上先闪一下暖墨底。
   */
  backgroundColor: nativeTheme.shouldUseDarkColors ? '#121110' : '#f5f0e7',
};

function createWindow() {
  mainWindow = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    // 无边框但仍可调整大小与贴边
    resizable: true,
    maximizable: true,
    autoHideMenuBar: true,
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
      mainWindow.webContents.send('win:maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', pushMaximized);
  mainWindow.on('unmaximize', pushMaximized);

  mainWindow.on('close', (event) => {
    // 关闭窗口时收进托盘，除非用户显式退出
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
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
 */
function loadRenderer(win) {
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

function appIconPath() {
  const candidates = [
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
  const image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
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

/* ------------------------------------------------------------------ IPC */

function registerIpc() {
  /* ------------------------------------------------ 自绘标题栏的窗口控制 */
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
    /** 启动时是否会自动请求管理员权限（设置页的开关读它） */
    autoElevate: readPrefs().autoElevate !== false,
    hostname: os.hostname(),
  }));

  ipcMain.handle('app:freePort', () => freePort());
  ipcMain.handle('app:openPath', (_e, target) => shell.openPath(String(target)));
  ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(String(url)));

  ipcMain.handle('app:relaunchElevated', () => requestElevation());

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
    if (!core.child?.pid) return null;
    try {
      const res = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-Process -Id ${core.child.pid} | Select-Object -Property WorkingSet64,CPU | ConvertTo-Json -Compress`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      );
      return res.stdout ? JSON.parse(res.stdout) : null;
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
    registerIpc();
    createWindow();
    createTray();
    if (!fs.existsSync(CORE_BIN)) {
      logLine(`警告：未找到 easytier-core（${CORE_BIN}）。请运行 pnpm fetch:easytier 或重新安装客户端。`, 'stderr');
    }
    if (!isElevated()) {
      logLine('当前未以管理员身份运行：创建虚拟网卡（TUN）会失败，请使用「以管理员身份重启」。', 'stderr');
    }
    /**
     * 等窗口画出来之后再清残留：查进程要起一次 PowerShell（几百毫秒），
     * 放在启动路径上会让双击图标到出现界面的那一下变慢。
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
     */
    if (shouldAutoElevate()) {
      logLine('未以管理员身份运行：正在请求提权（创建虚拟网卡需要）…', 'info');
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
    // Windows 上保持后台运行（托盘），不随窗口关闭退出
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
