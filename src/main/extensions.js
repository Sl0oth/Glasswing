// Wires Chrome extension APIs (chrome.tabs, chrome.windows, action popups, ...) to our tabs.
const { ElectronChromeExtensions } = require('electron-chrome-extensions')

let instance = null

function shellFor(win) {
  const { BrowserShell } = require('./shell')
  return (win && BrowserShell.fromWindow(win)) ?? null
}

function init(session) {
  const { BrowserShell } = require('./shell')

  instance = new ElectronChromeExtensions({
    session,

    async createTab(details) {
      const { BrowserWindow } = require('electron')
      const win = typeof details.windowId === 'number' ? BrowserWindow.fromId(details.windowId) : null
      const shell = shellFor(win) ?? BrowserShell.lastFocused() ?? BrowserShell.create({ urls: [] })
      const tab = shell.createTab({
        url: details.url,
        active: details.active !== false,
        index: typeof details.index === 'number' ? details.index : undefined,
        openerId: details.openerTabId ?? null,
      })
      return [tab.webContents, shell.win]
    },

    selectTab(webContents, win) {
      const shell = shellFor(win)
      shell?.selectTab(webContents.id)
      shell?.focus()
    },

    removeTab(webContents, win) {
      shellFor(win)?.closeTab(webContents.id)
    },

    async createWindow(details) {
      const urls = [].concat(details.url ?? [])
      const shell = BrowserShell.create({ urls })
      return shell.win
    },

    // Also called by the library when a window has already closed on its own.
    async removeWindow(win) {
      if (!win.isDestroyed()) win.close()
    },
  })

  ElectronChromeExtensions.handleCRXProtocol(session)
  return instance
}

module.exports = { init, get: () => instance }
