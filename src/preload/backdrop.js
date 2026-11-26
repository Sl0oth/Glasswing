// Preload for the window's tinted backdrop page.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('backdrop', {
  on: (callback) => ipcRenderer.on('backdrop', (_event, type, payload) => callback(type, payload)),
  divider: (action, x, y) => ipcRenderer.send('backdrop:divider', action, x, y),
  sidePanel: (action, x) => ipcRenderer.send('backdrop:side-panel', action, x),
})
