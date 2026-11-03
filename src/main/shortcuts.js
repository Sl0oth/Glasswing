// Keyboard shortcuts. Handled from `before-input-event` on every tab and on the toolbar UI,
// so they work no matter what has focus (and without a visible menu bar).
const { NEWTAB_URL } = require('./constants')

const isMac = process.platform === 'darwin'

function handle(shell, input) {
  if (input.type !== 'keyDown') return false
  const mod = isMac ? input.meta : input.control
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key
  const tab = shell.activeTab()
  const wc = tab?.webContents
  const run = (fn) => (fn(), true)

  if (mod && input.shift && !input.alt) {
    switch (key) {
      case 't': return run(() => shell.reopenClosedTab())
      case 'r': return run(() => wc?.reloadIgnoringCache())
      case 'f': return run(() => shell.toggleFocusMode())
      case 'i': return run(() => tab?.toggleDevTools())
      case 'w': return run(() => shell.win.close())
      case 'Tab': return run(() => shell.selectRelative(-1))
      case '[': case '{': return run(() => shell.selectRelative(-1))
      case ']': case '}': return run(() => shell.selectRelative(1))
      case '+': return run(() => tab?.zoom(1))
      case '_': return run(() => tab?.zoom(-1))
    }
  }

  if (mod && !input.shift && !input.alt) {
    switch (key) {
      case 't': return run(() => shell.createTab())
      case 'n': return run(() => shell.constructor.create())
      case 'w': return run(() => tab && shell.closeTab(tab.id))
      case 'l': case 'k': case 'e': return run(() => shell.focusAddressBar())
      case 'r': return run(() => wc?.reload())
      case 'f': return run(() => shell.openFind())
      case 'p': return run(() => wc?.print())
      case 'd': return run(() => require('./menus').addToFavorites(shell))
      case 'j': return run(() => shell.sendEvent('toggle-downloads'))
      case 'h': return run(() => require('./menus').runAction(shell, 'history'))
      case 'u': return run(() => tab && shell.createTab({ url: `view-source:${tab.url}`, openerId: tab.id }))
      case '=': case '+': return run(() => tab?.zoom(1))
      case '-': return run(() => tab?.zoom(-1))
      case '0': return run(() => tab?.zoom(0))
      case 'Tab': return run(() => shell.selectRelative(1))
      case 'PageDown': return run(() => shell.selectRelative(1))
      case 'PageUp': return run(() => shell.selectRelative(-1))
      case '[': return isMac ? run(() => wc?.navigationHistory.goBack()) : false
      case ']': return isMac ? run(() => wc?.navigationHistory.goForward()) : false
    }
    if (/^[1-9]$/.test(key)) return run(() => shell.selectIndex(Number(key)))
  }

  if (isMac && input.meta && input.alt && key === 'i') return run(() => tab?.toggleDevTools())

  if (input.alt && !mod && !input.shift) {
    switch (key) {
      case 'ArrowLeft': return run(() => wc?.navigationHistory.goBack())
      case 'ArrowRight': return run(() => wc?.navigationHistory.goForward())
      case 'Home': return run(() => tab?.loadURL(NEWTAB_URL))
      case 'd': return isMac ? false : run(() => shell.focusAddressBar())
    }
  }

  if (!mod && !input.alt) {
    switch (key) {
      case 'F5': return run(() => (input.shift ? wc?.reloadIgnoringCache() : wc?.reload()))
      case 'F6': return run(() => shell.focusAddressBar())
      case 'F11': return run(() => shell.toggleFullScreen())
      case 'F12': return run(() => tab?.toggleDevTools())
    }
  }

  return false
}

module.exports = { handle }
