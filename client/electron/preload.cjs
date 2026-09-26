/**
 * 渲染进程与主进程之间的白名单桥。
 * 只暴露显式列出的能力，渲染进程拿不到 Node/fs/child_process。
 */
const { contextBridge, ipcRenderer } = require('electron');

/** 是否开启自动化注入口（见 lib/notify-setup.ts 与 main.cjs 的 notify:simulateClick） */
const testHooks = process.env.MCLINK_TEST_HOOKS === '1';

contextBridge.exposeInMainWorld('mclink', {
  /**
   * 平台标识（**同步**，不走 IPC）。
   *
   * 为什么要同步给：渲染层大量分支是"要不要画这个按钮/写这句文案"，
   * 都发生在首次渲染之前；异步拿 info() 会让界面先按 Windows 画一遍再跳到 mac 版
   * （红黄绿按钮会闪一下自绘按钮）。preload 里 `process.platform` 是现成的。
   */
  platform: process.platform,
  /**
   * 是否开启自动化注入口（`MCLINK_TEST_HOOKS=1` 启动时才为 true）。
   * 渲染层据此决定要不要把测试钩子挂到 window 上 —— 见 lib/notify-setup.ts。
   */
  testHooks,
  info: () => ipcRenderer.invoke('app:info'),
  freePort: () => ipcRenderer.invoke('app:freePort'),
  /** TCP 延迟探测（建房页选节点）：入参 `[{host, port}]`，返回 `{ "host:port": ms|null }` */
  tcping: (targets) => ipcRenderer.invoke('net:tcping', targets),
  openPath: (target) => ipcRenderer.invoke('app:openPath', target),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  relaunchElevated: () => ipcRenderer.invoke('app:relaunchElevated'),
  setAutoElevate: (enabled) => ipcRenderer.invoke('app:setAutoElevate', enabled),
  /** 「有人发消息时提醒我」：落进 client-prefs.json（与 closeAction/autoElevate 同一套） */
  setNotifyMessages: (enabled) => ipcRenderer.invoke('app:setNotifyMessages', enabled),

  /**
   * 系统通知（Windows = toast，macOS = 通知中心）。
   *
   * 判定在渲染层（谁看得见消息只有它知道），**弹**在主进程 ——
   * 点通知要把窗口从托盘/菜单栏里叫回来，那只有主进程做得到。
   */
  notify: {
    show: (payload) => ipcRenderer.invoke('notify:show', payload),
    /** 通知实况：supported / requested / shown / failed（排查"为什么没弹"） */
    state: () => ipcRenderer.invoke('notify:state'),
    /** 用户点了通知：主进程已经把窗口叫回来了，这里只需要跳到那个房间 */
    onActivate: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('app:notify-click', listener);
      return () => ipcRenderer.removeListener('app:notify-click', listener);
    },
    /**
     * 自动化专用：让主进程走一遍「通知被点击」的那条路径。
     * 只在 MCLINK_TEST_HOOKS=1 时才存在（主进程那边同样只在那个开关下注册 handler）——
     * 系统通知的"点击"没法用脚本模拟，但落点必须能被断言（回到房间页）。
     */
    ...(testHooks ? { simulateClickForTest: (roomId) => ipcRenderer.invoke('notify:simulateClick', roomId) } : {}),
  },
  confirm: (payload) => ipcRenderer.invoke('dialog:confirm', payload),
  /** 关闭窗口时的默认行为：ask / tray / quit */
  setCloseAction: (value) => ipcRenderer.invoke('app:setCloseAction', value),
  /** 主进程询问"彻底退出还是最小化"时回调（见 components/CloseConfirm.vue） */
  onAskClose: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('app:ask-close', listener);
    return () => ipcRenderer.removeListener('app:ask-close', listener);
  },
  /** 告诉主进程：询问框已经弹出来了（撤掉它的 8 秒兜底） */
  closeAskOpened: () => ipcRenderer.invoke('app:closeAskOpened'),
  /** 回答主进程：tray / quit / cancel，以及要不要记住 */
  closeDecision: (payload) => ipcRenderer.invoke('app:closeDecision', payload),

  /**
   * macOS 菜单栏发来的命令（当前只有 'settings'，对应 ⌘,）。
   * Windows 上不会有消息 —— 那个平台不建原生菜单（见 main.cjs 的 buildApplicationMenu）。
   */
  onMenuCommand: (handler) => {
    const listener = (_event, command) => handler(String(command));
    ipcRenderer.on('app:menu-command', listener);
    return () => ipcRenderer.removeListener('app:menu-command', listener);
  },

  /**
   * 自绘标题栏的窗口控制。
   * 窗口是无边框的（frame: false），所以最小化/最大化/关闭都得由界面来触发。
   */
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    close: () => ipcRenderer.invoke('win:close'),
    hide: () => ipcRenderer.invoke('win:hide'),
    onMaximized: (handler) => {
      const listener = (_event, flag) => handler(Boolean(flag));
      ipcRenderer.on('win:maximized', listener);
      return () => ipcRenderer.removeListener('win:maximized', listener);
    },
  },

  core: {
    start: (payload) => ipcRenderer.invoke('core:start', payload),
    stop: () => ipcRenderer.invoke('core:stop'),
    status: () => ipcRenderer.invoke('core:status'),
    logs: (limit) => ipcRenderer.invoke('core:logs', limit),
    resourceUsage: () => ipcRenderer.invoke('core:resourceUsage'),
    applyAcl: (aclToml) => ipcRenderer.invoke('core:applyAcl', aclToml),
    peers: () => ipcRenderer.invoke('core:peers'),
    cli: (args) => ipcRenderer.invoke('core:cli', args),
    onStatus: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('core:status', listener);
      return () => ipcRenderer.removeListener('core:status', listener);
    },
    onLog: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('core:log', listener);
      return () => ipcRenderer.removeListener('core:log', listener);
    },
  },
});
