// Messages from the toolbar UI. Only the UI view of a known window may send them.
const { ipcMain } = require('electron')
const { BrowserShell } = require('./shell')
const { fetchSuggestions } = require('./protocol')
const { downloadAction, listDownloads } = require('./downloads')
const { isNewTab, resolveInput } = require('./url')
const history = require('./history')
const appearance = require('./appearance')
const prompts = require('./prompts')
const menus = require('./menus')

const num = (v) => (Number.isFinite(v) ? v : NaN)

const commands = {
  'new-tab': (shell) => shell.createTab(),
  'select-tab': (shell, id) => shell.selectTab(num(id)),
  'close-tab': (shell, id) => shell.closeTab(num(id)),
  'move-tab': (shell, id, index) => shell.moveTab(num(id), num(index)),
  'tab-menu': (shell, id, x, y) => menus.tabContextMenu(shell, num(id), num(x) || 0, num(y) || 0),
  'menu-select': (shell, id) => menus.selectMenuItem(shell, id == null ? null : num(id)),
  'toggle-mute': (shell, id) => {
    const tab = shell.tabs.get(num(id))
    if (!tab) return
    tab.webContents.setAudioMuted(!tab.webContents.isAudioMuted())
    shell.tabChanged(tab)
  },
  'menu-action': (shell, action) => menus.runAction(shell, String(action)),
  'new-tab-menu': (shell, x, y) => menus.newTabButtonMenu(shell, num(x) || 0, num(y) || 0),

  navigate: (shell, input, { newTab = false } = {}) => {
    const url = resolveInput(input)
    if (!url) return
    const active = shell.activeTab()
    const tab = newTab || !active ? shell.createTab({ url }) : (active.loadURL(url), active)
    tab.webContents.focus()
  },
  back: (shell) => shell.activeTab()?.webContents.navigationHistory.goBack(),
  forward: (shell) => shell.activeTab()?.webContents.navigationHistory.goForward(),
  reload: (shell) => shell.activeTab()?.webContents.reload(),
  stop: (shell) => shell.activeTab()?.webContents.stop(),
  'zoom-reset': (shell) => shell.activeTab()?.zoom(0),
  'focus-page': (shell) => shell.focusPage(),

  expand: (shell, expanded) => shell.setExpanded(expanded),
  reveal: (shell, revealed) => shell.setRevealed(revealed),

  'find-open': (shell) => shell.openFind(),
  'find-close': (shell) => shell.closeFind(),
  find: (shell, text, opts) => shell.find(String(text ?? ''), opts ?? {}),

  download: (_shell, action, id) => downloadAction(String(action), num(id)),

  'prompt-response': (shell, id, button, checked) => prompts.respond(shell, num(id), button, checked),

  appearance: (_shell, partial) => appearance.update(partial),
  'appearance-reset': () => appearance.reset(),
  'toggle-focus-mode': (shell) => shell.toggleFocusMode(),

  window: (shell, action) => {
    const win = shell.win
    if (action === 'close') win.close()
    else if (action === 'minimize') win.minimize()
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
  },
}

function localSuggestions(shell, text) {
  const query = text.trim().toLowerCase()
  if (!query) return { history: [], tabs: [], completion: null }

  const tabs = []
  for (const s of BrowserShell.all) {
    for (const id of s.order) {
      const tab = s.tabs.get(id)
      if (s === shell && id === shell.activeId) continue
      if (isNewTab(tab.url)) continue
      if (tab.title.toLowerCase().includes(query) || tab.url.toLowerCase().includes(query)) {
        tabs.push({ id, title: tab.title, url: tab.url, windowId: s.win.id })
      }
    }
  }

  const { results, completion } = history.query(query, 5)
  const tabUrls = new Set(tabs.map((t) => t.url))
  return {
    tabs: tabs.slice(0, 3),
    history: results.filter((h) => !tabUrls.has(h.url)).slice(0, 4),
    completion,
  }
}

function setupIpc() {
  ipcMain.on('ui:command', (event, name, ...args) => {
    const shell = BrowserShell.fromUi(event.sender)
    const command = Object.hasOwn(commands, name) ? commands[name] : null
    if (!shell || !command) return
    try {
      command(shell, ...args)
    } catch (err) {
      console.error(`UI command "${name}" failed:`, err)
    }
  })

  ipcMain.handle('ui:invoke', async (event, name, ...args) => {
    const shell = BrowserShell.fromUi(event.sender)
    if (!shell) throw new Error('Unknown sender')
    switch (name) {
      case 'state':
        return shell.getState()
      case 'downloads':
        return listDownloads()
      case 'appearance':
        return {
          settings: appearance.get(),
          presets: appearance.PRESETS,
          accents: appearance.ACCENTS,
          materials: process.platform === 'win32' ? appearance.MATERIALS : [],
        }
      case 'suggest-local':
        return localSuggestions(shell, String(args[0] ?? ''))
      case 'suggest-search':
        return fetchSuggestions(String(args[0] ?? ''))
      case 'switch-to-tab': {
        const target = [...BrowserShell.all].find((s) => s.tabs.has(num(args[0])))
        target?.selectTab(num(args[0]))
        target?.focus()
        return Boolean(target)
      }
      default:
        throw new Error(`Unknown request: ${name}`)
    }
  })
}

module.exports = { setupIpc }
