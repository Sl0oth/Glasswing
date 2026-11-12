// Preload for the setup window.
const { contextBridge, ipcRenderer } = require('electron')

const call = (channel) => (...args) => ipcRenderer.invoke(`setup:${channel}`, ...args)

contextBridge.exposeInMainWorld('setup', {
  state: call('state'),
  appearance: call('appearance'),
  search: call('search'),
  protection: call('protection'),
  updates: call('updates'),
  import: call('import'),
  finish: call('finish'),
})
