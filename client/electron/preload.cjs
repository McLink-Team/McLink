/**
 * 渲染进程与主进程之间的白名单桥。
 * 只暴露显式列出的能力，渲染进程拿不到 Node/fs/child_process。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mclink', {
  info: () => ipcRenderer.invoke('app:info'),
  freePort: () => ipcRenderer.invoke('app:freePort'),
  /** ICMP 延迟探测：入参是主机名/IP 数组，返回 { host: ms|null } */
  ping: (hosts) => ipcRenderer.invoke('net:ping', hosts),
  openPath: (target) => ipcRenderer.invoke('app:openPath', target),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  relaunchElevated: () => ipcRenderer.invoke('app:relaunchElevated'),
  setAutoElevate: (enabled) => ipcRenderer.invoke('app:setAutoElevate', enabled),
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
