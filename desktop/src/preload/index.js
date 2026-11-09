'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * 渲染层唯一的入口。白名单式暴露，渲染进程拿不到 token、fs、child_process。
 */
function pathOf(file) {
  // Electron 32+：从 File 对象取真实路径；旧版本回退到 file.path
  try {
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      const p = webUtils.getPathForFile(file);
      if (p) return p;
    }
  } catch {
    /* 忽略，走回退 */
  }
  return (file && file.path) || null;
}

contextBridge.exposeInMainWorld('api', {
  auth: {
    login: (username, password) => ipcRenderer.invoke('auth:login', { username, password }),
    session: () => ipcRenderer.invoke('auth:session'),
    status: () => ipcRenderer.invoke('auth:status'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    /** refresh 失效时主进程主动通知，UI 回登录页 */
    onSessionLost: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('auth:lost', listener);
      return () => ipcRenderer.removeListener('auth:lost', listener);
    },
  },
  convert: {
    formats: () => ipcRenderer.invoke('convert:formats'),
    run: (file, target, jobId) =>
      ipcRenderer.invoke('convert:run', { path: pathOf(file), target, jobId }),
    onProgress: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('convert:progress', listener);
      return () => ipcRenderer.removeListener('convert:progress', listener);
    },
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    reveal: (target) => ipcRenderer.invoke('app:reveal', target),
  },
});
