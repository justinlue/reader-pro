const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.send('state:save', state),
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  readFile: (path) => ipcRenderer.invoke('file:read', path),
  listFonts: () => ipcRenderer.invoke('fonts:list'),
  toggleFullscreen: () => ipcRenderer.send('window:fullscreen'),
  toggleDevTools: () => ipcRenderer.send('window:devtools'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  initialFile: () => ipcRenderer.invoke('app:initial-file'),
  onOpenFile: (fn) => ipcRenderer.on('open-file', (_e, path) => fn(path)),
});
