/**
 * mclink Windows 客户端 —— Electron 主进程。
 *
 * 职责划分：
 *   主进程  = 唯一有权启动/停止 easytier-core、读写配置、申请提权、管理托盘的角色
 *   渲染进程 = 纯 UI，通过 preload 暴露的白名单 API 与主进程通信
 *
 * 之所以把核心进程生命周期放在主进程：渲染进程可能被回收/节流，
 * 而虚拟网络必须一直在后台跑着。
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');

const isDev = !app.isPackaged;
/** 只有显式设置了该变量（scripts/dev.mjs 会设置）才去连开发服务器 */
const DEV_URL = process.env.MCLINK_CLIENT_DEV_URL || '';
const DEV_FALLBACK_URL = 'http://127.0.0.1:5174';

/* ------------------------------------------------------------------ 路径 */

function resolveVendorDir() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'vendor', 'easytier')]
    : [
        path.join(__dirname, '..', '..', 'vendor', 'easytier'),
        path.join(__dirname, '..', 'vendor', 'easytier'),
      ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0];
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
  if (process.platform !== 'win32') return true;
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

/* ------------------------------------------------------------ 核心进程 */

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

/**
 * 启动 easytier-core。
 * @param {{ configToml: string, launchArgs?: string[], instanceName?: string }} payload
 */
async function startCore(payload) {
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
    setState('error', `easytier-core 意外退出（退出码 ${code}）`);
    // 崩溃后自动重试一次，避免网络因为偶发问题一直断着
    if (replay) {
      setTimeout(() => {
        if (!core.child && replay && !quitting) {
          logLine('尝试自动重启 easytier-core…', 'info');
          startCore(replay).catch(() => {});
        }
      }, 4000);
    }
  });

  // EasyTier 没有就绪信号，用短延迟把「能起来」与「立刻崩溃」区分开
  setTimeout(() => {
    if (core.child && !quitting) {
      core.startedAt = new Date().toISOString();
      setState('running');
    }
  }, 1400);

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: '#05070f',
    autoHideMenuBar: true,
    title: 'mclink',
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
  win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      '<body style="background:#05070f;color:#e9edf9;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">' +
        '<div style="text-align:center"><h2>渲染资源缺失</h2><p style="color:#a7b1cd">请重新安装客户端。</p></div></body>',
    )}`,
  );
}

function appIconPath() {  const candidates = [
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
  tray.setToolTip('mclink 《我的世界》联机');
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const label =
    core.state === 'running' ? '已连接' : core.state === 'starting' ? '正在连接…' : core.state === 'error' ? '连接异常' : '未连接';
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `mclink —— ${label}`, enabled: false },
      { type: 'separator' },
      {
        label: '显示主窗口',
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
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
    hostname: os.hostname(),
  }));

  ipcMain.handle('app:freePort', () => freePort());
  ipcMain.handle('app:openPath', (_e, target) => shell.openPath(String(target)));
  ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(String(url)));

  ipcMain.handle('app:relaunchElevated', async () => {
    if (process.platform !== 'win32') return { ok: false, error: '仅 Windows 需要提权' };
    return new Promise((resolve) => {
      const exe = process.execPath;
      const args = app.isPackaged ? [] : [path.join(__dirname, '..')];
      const psArgs = [`-FilePath`, `"${exe}"`].join(' ');
      const command = `Start-Process -FilePath '${exe}' -ArgumentList ${args
        .map((a) => `'${a}'`)
        .join(',')} -Verb RunAs`;
      void psArgs;
      try {
        const child = spawn('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true });
        child.on('close', (code) => {
          if (code === 0) {
            quitting = true;
            app.quit();
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: `提权启动失败（退出码 ${code}）` });
          }
        });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
  });

  ipcMain.handle('core:start', async (_e, payload) => {
    try {
      return await startCore(payload ?? {});
    } catch (err) {
      return setState('error', err.message);
    }
  });
  ipcMain.handle('core:stop', () => stopCore());
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
    mainWindow?.show();
    mainWindow?.focus();
  });

  app.whenReady().then(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });
    registerIpc();
    createWindow();
    createTray();
    if (!fs.existsSync(CORE_BIN)) {
      logLine(`警告：未找到 easytier-core（${CORE_BIN}）。请运行 pnpm fetch:easytier 或重新安装客户端。`, 'stderr');
    }
    if (!isElevated()) {
      logLine('当前未以管理员身份运行：创建虚拟网卡（TUN）会失败，请使用「以管理员身份重启」。', 'stderr');
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
