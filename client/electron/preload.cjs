/**
 * 渲染进程与主进程之间的白名单桥。
 * 只暴露显式列出的能力，渲染进程拿不到 Node/fs/child_process。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mclink', {
  info: () => ipcRenderer.invoke('app:info'),
  freePort: () => ipcRenderer.invoke('app:freePort'),
  openPath: (target) => ipcRenderer.invoke('app:openPath', target),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  relaunchElevated: () => ipcRenderer.invoke('app:relaunchElevated'),
  confirm: (payload) => ipcRenderer.invoke('dialog:confirm', payload),

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
