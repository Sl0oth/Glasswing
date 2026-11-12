// Preload for the window's tinted backdrop page.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('backdrop', {
  on: (callback) => ipcRenderer.on('backdrop', (_event, type, payload) => callback(type, payload)),
  divider: (action, x) => ipcRenderer.send('backdrop:divider', action, x),
})
