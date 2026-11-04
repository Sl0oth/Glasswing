// Wires Chrome extension APIs (chrome.tabs, chrome.windows, action popups, ...) to our tabs.
const { ElectronChromeExtensions } = require('electron-chrome-extensions')

let instance = null
// The library reports every tab change back through selectTab, including the ones we told it about
// and every newly added tab. Only requests that really come from an extension may switch tabs.
let syncing = false

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
      if (syncing) return
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

function quietly(fn) {
  if (!instance) return
  syncing = true
  try {
    fn()
  } finally {
    syncing = false
  }
}

/** Registers a tab. The library assumes a new tab is active, so it's told which one really is. */
function addTab(webContents, win, activeWebContents) {
  quietly(() => {
    instance.addTab(webContents, win)
    if (activeWebContents) instance.selectTab(activeWebContents)
  })
}

/** Tells extensions which tab is now active. */
function tabSelected(webContents) {
  quietly(() => instance.selectTab(webContents))
}

/**
 * Tells extensions a tab now belongs to another window. The library has no call for this, and
 * removing and re-adding the tab would attach all of its page listeners a second time.
 */
function tabMoved(webContents, win) {
  const store = instance?.ctx?.store
  if (!store?.tabs?.has(webContents)) return
  store.tabToWindow.set(webContents, win)
  store.addWindow(win)
}

module.exports = { init, get: () => instance, addTab, tabSelected, tabMoved }
