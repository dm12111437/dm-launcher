// DM启动台 - 预加载脚本（安全桥接）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dm', {
  listGames: () => ipcRenderer.invoke('games:list'),
  launch: (folder) => ipcRenderer.invoke('game:launch', folder),
  openPath: (folder) => ipcRenderer.invoke('game:open-path', folder),
  chooseExe: (folder) => ipcRenderer.invoke('game:choose-exe', folder),
  clearOverride: (folder) => ipcRenderer.invoke('game:clear-override', folder),
  setOptions: (folder, opts) => ipcRenderer.invoke('game:set-options', folder, opts),
  excludeGame: (folder) => ipcRenderer.invoke('games:exclude', folder),
  unexcludeGame: (folder) => ipcRenderer.invoke('games:unexclude', folder),
  getAbout: () => ipcRenderer.invoke('about:get'),
  setFullscreen: (flag) => ipcRenderer.invoke('window:fullscreen', flag),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  getGroups: () => ipcRenderer.invoke('groups:get'),
  detectGroup: (type) => ipcRenderer.invoke('groups:detect', type),
  importGroups: () => ipcRenderer.invoke('groups:import'),
  pickDirs: () => ipcRenderer.invoke('groups:pick-dirs'),
  addGroup: (group) => ipcRenderer.invoke('groups:add', group),
  updateGroup: (patch) => ipcRenderer.invoke('groups:update', patch),
  deleteGroup: (id) => ipcRenderer.invoke('groups:delete', id),
  moveGroup: (id, delta) => ipcRenderer.invoke('groups:move', id, delta),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  hide: () => ipcRenderer.invoke('window:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onLaunchError: (cb) => ipcRenderer.on('launch-error', (e, info) => cb(info)),
  onToast: (cb) => ipcRenderer.on('toast', (e, info) => cb(info))
});
