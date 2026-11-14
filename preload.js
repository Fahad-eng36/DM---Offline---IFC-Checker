// The only bridge between the window and this computer: a fixed list of requests, no general access.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('dm', {
  getRules: () => ipcRenderer.invoke('rules:get'),
  pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return ''; } },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickFolder: () => ipcRenderer.invoke('pick:folder'),
  pickExe: (title) => ipcRenderer.invoke('pick:exe', title),
  inspectFolder: (folder) => ipcRenderer.invoke('folder:inspect', folder),
  runCheck: (opts) => ipcRenderer.invoke('check:run', opts),
  importResults: (folder) => ipcRenderer.invoke('check:import', folder),
  stopCheck: () => ipcRenderer.invoke('check:stop'),
  onProgress: (fn) => ipcRenderer.on('check:progress', (e, data) => fn(data)),
  historyList: () => ipcRenderer.invoke('history:list'),
  historyGet: (id) => ipcRenderer.invoke('history:get', id),
  historyDelete: (id) => ipcRenderer.invoke('history:delete', id),
  showInFolder: (p) => ipcRenderer.invoke('open:path', p),
  saveCsv: (name, text) => ipcRenderer.invoke('save:csv', name, text)
});
