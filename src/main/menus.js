// Context menus and the "⋯" menu. They're described with Electron-style templates but drawn by
// the toolbar UI in Glasswing's own style (see `showMenu`), not as native OS menus.
const { Menu, clipboard, shell: electronShell, app } = require('electron')
const { APP_NAME, EXTENSIONS_URL, PASSWORDS_URL, HISTORY_URL, WEB_STORE_URL, FAVICON_URL } = require('./constants')
const history = require('./history')
const { searchUrl, isNewTab, isInternal } = require('./url')
const extensions = require('./extensions')
const store = require('./store')

const isMac = process.platform === 'darwin'
const accel = (key) => ({ accelerator: key })
const truncate = (s, n = 32) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * Sends a menu to the UI to draw at (x, y) in window coordinates. Click handlers stay here and
 * run when the UI reports a selection (`selectMenuItem`).
 */
function showMenu(shell, template, { x, y, fromPage = false }) {
  const handlers = new Map()
  let nextId = 0
  const convert = (items) =>
    items.filter(Boolean).map((item) => {
      if (item.type === 'separator') return { type: 'separator' }
      const id = ++nextId
      if (item.click) handlers.set(id, item.click)
      return {
        id,
        label: item.label,
        icon: typeof item.icon === 'string' ? item.icon : null,
        accelerator: item.accelerator ?? null,
        enabled: item.enabled !== false,
        checked: item.type === 'checkbox' || item.type === 'radio' ? Boolean(item.checked) : null,
        submenu: item.submenu ? convert(item.submenu) : null,
      }
    })
  const items = convert(template)
  while (items.at(-1)?.type === 'separator') items.pop()
  shell.menu = { handlers, fromPage }
  shell.ui.webContents.focus()
  shell.sendEvent('menu', { items, x: Math.round(x), y: Math.round(y) })
}

function selectMenuItem(shell, id) {
  const menu = shell.menu
  shell.menu = null
  if (!menu) return
  if (menu.fromPage && id == null) shell.focusPage()
  const handler = id != null ? menu.handlers.get(id) : null
  if (!handler) return
  if (menu.fromPage) shell.focusPage()
  try {
    handler()
  } catch (err) {
    console.error('Menu action failed:', err)
  }
}

/** Extension menu items arrive as Electron MenuItems; turn them into plain templates. */
function fromMenuItems(menuItems) {
  return menuItems.map((mi) =>
    mi.type === 'separator'
      ? { type: 'separator' }
      : {
          label: mi.label,
          type: mi.type,
          checked: mi.checked,
          enabled: mi.enabled,
          click: () => mi.click(),
          submenu: mi.submenu ? fromMenuItems(mi.submenu.items) : undefined,
        },
  )
}

function pageContextMenu(tab, params) {
  const { shell } = tab
  const wc = tab.webContents
  const items = []
  const sep = () => items.length && items.at(-1).type !== 'separator' && items.push({ type: 'separator' })

  if (params.misspelledWord && params.dictionarySuggestions.length) {
    for (const word of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: word, click: () => wc.replaceMisspelling(word) })
    }
    sep()
  }

  if (params.linkURL) {
    items.push(
      { label: 'Open Link in New Tab', click: () => shell.createTab({ url: params.linkURL, active: false, openerId: tab.id }) },
      { label: 'Open Link in New Window', click: () => shell.constructor.create({ urls: [params.linkURL] }) },
      { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) },
    )
    sep()
  }

  if (params.mediaType === 'image' && params.srcURL) {
    items.push(
      { label: 'Open Image in New Tab', click: () => shell.createTab({ url: params.srcURL, active: false, openerId: tab.id }) },
      { label: 'Save Image', click: () => wc.downloadURL(params.srcURL) },
      { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
      { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
    )
    sep()
  }

  if (params.isEditable) {
    const f = params.editFlags
    items.push(
      { label: 'Undo', ...accel('CmdOrCtrl+Z'), enabled: f.canUndo, click: () => wc.undo() },
      { label: 'Redo', ...accel('CmdOrCtrl+Y'), enabled: f.canRedo, click: () => wc.redo() },
      { type: 'separator' },
      { label: 'Cut', ...accel('CmdOrCtrl+X'), enabled: f.canCut, click: () => wc.cut() },
      { label: 'Copy', ...accel('CmdOrCtrl+C'), enabled: f.canCopy, click: () => wc.copy() },
      { label: 'Paste', ...accel('CmdOrCtrl+V'), enabled: f.canPaste, click: () => wc.paste() },
      { label: 'Select All', ...accel('CmdOrCtrl+A'), enabled: f.canSelectAll, click: () => wc.selectAll() },
    )
    sep()
  } else if (params.selectionText.trim()) {
    const text = params.selectionText.trim()
    items.push(
      { label: 'Copy', ...accel('CmdOrCtrl+C'), click: () => wc.copy() },
      { label: `Search DuckDuckGo for “${truncate(text)}”`, click: () => shell.createTab({ url: searchUrl(text), openerId: tab.id }) },
    )
    sep()
  }

  if (!params.linkURL && !params.isEditable && !params.selectionText.trim() && params.mediaType === 'none') {
    const nav = wc.navigationHistory
    items.push(
      { label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() },
      { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Print…', click: () => wc.print() },
    )
    if (!isInternal(tab.url)) {
      items.push({ label: 'View Page Source', click: () => shell.createTab({ url: `view-source:${tab.url}`, openerId: tab.id }) })
    }
    sep()
  }

  try {
    const extensionItems = extensions.get()?.getContextMenuItems(wc, params) ?? []
    if (extensionItems.length) {
      items.push(...fromMenuItems(extensionItems))
      sep()
    }
  } catch {}

  items.push({ label: 'Inspect Element', click: () => {
    wc.inspectElement(params.x, params.y)
    if (wc.isDevToolsOpened()) wc.devToolsWebContents?.focus()
  } })

  // Page coordinates → window coordinates (the page view is inset in the window).
  const bounds = tab.view.getBounds()
  showMenu(shell, items, { x: bounds.x + params.x, y: bounds.y + params.y, fromPage: true })
}

function tabContextMenu(shell, id, x, y) {
  const tab = shell.tabs.get(id)
  if (!tab) return
  const wc = tab.webContents
  const index = shell.order.indexOf(id)
  showMenu(shell, [
    { label: 'Reload', click: () => (tab.ensureLoaded(), wc.reload()) },
    { label: 'Duplicate', click: () => shell.duplicateTab(id) },
    { label: wc.isAudioMuted() ? 'Unmute Tab' : 'Mute Tab', click: () => (wc.setAudioMuted(!wc.isAudioMuted()), shell.tabChanged(tab)) },
    { label: 'Add to Favorites', enabled: /^https?:/.test(tab.url), click: () => addToFavorites(shell, tab) },
    { type: 'separator' },
    { label: 'Close Tab', ...accel('CmdOrCtrl+W'), click: () => shell.closeTab(id) },
    { label: 'Close Other Tabs', enabled: shell.order.length > 1, click: () => shell.closeOtherTabs(id) },
    { label: 'Close Tabs to the Right', enabled: index < shell.order.length - 1, click: () => shell.closeTabsToRight(id) },
    { type: 'separator' },
    { label: 'Reopen Closed Tab', ...accel('CmdOrCtrl+Shift+T'), enabled: shell.closedTabs.length > 0, click: () => shell.reopenClosedTab() },
  ], { x, y })
}

/** Right-click on the + button: the last 10 pages visited, then a way into full history. */
function newTabButtonMenu(shell, x, y) {
  const recent = history.recent(10)
  const items = recent.map((entry) => {
    let host = entry.url
    try {
      host = new URL(entry.url).hostname.replace(/^www\./, '')
    } catch {}
    return {
      label: truncate(entry.title || host, 48),
      icon: FAVICON_URL.replace('%s', encodeURIComponent(host)),
      click: () => shell.createTab({ url: entry.url }),
    }
  })
  if (!items.length) items.push({ label: 'No history yet', enabled: false })
  items.push(
    { type: 'separator' },
    { label: 'Show All History', ...accel('CmdOrCtrl+H'), click: () => openOrSelect(shell, HISTORY_URL) },
  )
  showMenu(shell, items, { x, y })
}

/** Actions from the ⋯ panel (the panel itself is drawn by the toolbar UI). */
function runAction(shell, action) {
  const tab = shell.activeTab()
  const actions = {
    'new-tab': () => shell.createTab(),
    'new-window': () => shell.constructor.create(),
    find: () => tab && shell.openFind(),
    'zoom-in': () => tab?.zoom(1),
    'zoom-out': () => tab?.zoom(-1),
    'zoom-reset': () => tab?.zoom(0),
    'toggle-autohide': () => shell.toggleFocusMode(),
    'toggle-fullscreen': () => shell.toggleFullScreen(),
    favorite: () => addToFavorites(shell),
    'reopen-tab': () => shell.reopenClosedTab(),
    extensions: () => openOrSelect(shell, EXTENSIONS_URL),
    'web-store': () => shell.createTab({ url: WEB_STORE_URL }),
    passwords: () => openOrSelect(shell, PASSWORDS_URL),
    history: () => openOrSelect(shell, HISTORY_URL),
    'downloads-folder': () => electronShell.openPath(app.getPath('downloads')),
    print: () => tab?.webContents.print(),
    devtools: () => tab?.toggleDevTools(),
    about: () => about(shell),
    quit: () => app.quit(),
  }
  if (Object.hasOwn(actions, action)) actions[action]()
}

function openOrSelect(shell, url) {
  for (const id of shell.order) {
    if (shell.tabs.get(id).url.startsWith(url)) return shell.selectTab(id)
  }
  const active = shell.activeTab()
  if (active && isNewTab(active.url)) active.loadURL(url)
  else shell.createTab({ url })
}

function addToFavorites(shell, tab = shell.activeTab()) {
  if (!tab || !/^https?:/.test(tab.url)) return
  const favorites = store.get('favorites')
  if (!favorites.some((f) => f.url === tab.url)) {
    store.set('favorites', [...favorites, { title: tab.title, url: tab.url }])
  }
  shell.sendEvent('flash', 'Added to Favorites')
}

function about(shell) {
  require('./prompts').ask(shell, {
    title: APP_NAME,
    message: `Version ${app.getVersion()}`,
    detail: `Chromium ${process.versions.chrome} · Electron ${process.versions.electron}\nSearch by DuckDuckGo`,
    buttons: [{ id: 'ok', label: 'OK', style: 'primary' }],
    cancelId: 'ok',
  })
}

/** macOS needs an application menu for standard edit shortcuts to work in text fields. */
function applicationMenu() {
  if (!isMac) return null
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ])
}

module.exports = {
  pageContextMenu,
  tabContextMenu,
  newTabButtonMenu,
  runAction,
  selectMenuItem,
  addToFavorites,
  applicationMenu,
  openOrSelect,
}
