// Gives extension pages and service workers chrome.sidePanel (see src/main/side-panel.js). Websites don't get it.
// It runs before the extensions library's preload, which freezes `chrome` once it has added its own APIs.
const { contextBridge, ipcRenderer } = require('electron')

// A service worker's preload can't see its address. Only extensions' workers have `chrome`, and only theirs are answered.
const here = globalThis.location?.href ?? ''
if (process.type === 'service-worker' || here.startsWith('chrome-extension://')) {
  try {
    contextBridge.exposeInMainWorld('__glasswingSidePanel', {
      call: (method, arg) => ipcRenderer.invoke('side-panel:call', method, arg),
    })
    contextBridge.executeInMainWorld({
      func: () => {
        const bridge = globalThis.__glasswingSidePanel
        delete globalThis.__glasswingSidePanel
        const chrome = globalThis.chrome
        if (!bridge || !chrome || chrome.sidePanel) return
        // Promise style and callback style, as in Chrome.
        const method = (name) => (arg, callback) => {
          if (typeof arg === 'function') [arg, callback] = [undefined, arg]
          const result = bridge.call(name, arg ?? {})
          if (typeof callback !== 'function') return result
          result.then((value) => callback(value), () => callback())
        }
        const event = () => {
          const listeners = new Set()
          return {
            addListener: (fn) => listeners.add(fn),
            removeListener: (fn) => listeners.delete(fn),
            hasListener: (fn) => listeners.has(fn),
            hasListeners: () => listeners.size > 0,
          }
        }
        Object.defineProperty(chrome, 'sidePanel', {
          value: {
            setOptions: method('setOptions'),
            getOptions: method('getOptions'),
            setPanelBehavior: method('setPanelBehavior'),
            getPanelBehavior: method('getPanelBehavior'),
            open: method('open'),
            close: method('close'),
            onOpened: event(),
            onClosed: event(),
          },
          enumerable: true,
          configurable: true,
        })
      },
    })
  } catch (err) {
    console.error('Glasswing: could not add chrome.sidePanel', err)
  }
}
