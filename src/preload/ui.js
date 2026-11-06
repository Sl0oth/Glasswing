// Preload for the toolbar UI only (never for web pages).
const { contextBridge, ipcRenderer } = require('electron')
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action')

// Enables the <browser-action-list> element that renders extension buttons. Private windows don't have any.
if (!new URLSearchParams(location.search).has('private')) injectBrowserAction()

contextBridge.exposeInMainWorld('glasswing', {
  platform: process.platform,
  send: (command, ...args) => ipcRenderer.send('ui:command', command, ...args),
  invoke: (request, ...args) => ipcRenderer.invoke('ui:invoke', request, ...args),
  onState: (callback) => ipcRenderer.on('ui:state', (_event, state) => callback(state)),
  onEvent: (callback) => ipcRenderer.on('ui:event', (_event, type, payload) => callback(type, payload)),
})
