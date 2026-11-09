// Context menus and the "⋯" menu. They're described with Electron-style templates but drawn by
// the toolbar UI in Glasswing's own style (see `showMenu`), not as native OS menus.
const { Menu, clipboard, shell: electronShell, app } = require('electron')
const { APP_NAME, EXTENSIONS_URL, PASSWORDS_URL, HISTORY_URL, PROTECTION_URL, WEB_STORE_URL, FAVICON_URL } = require('./constants')
const history = require('./history')
const { searchUrl, resolveInput, isNewTab, isInternal } = require('./url')
const extensions = require('./extensions')
const favorites = require('./favorites')
const appearance = require('./appearance')
const search = require('./search')

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
      { label: 'Open Link in New Window', click: () => shell.newWindow({ urls: [params.linkURL] }) },
      !shell.private && { label: 'Open Link in Private Window', click: () => shell.constructor.create({ urls: [params.linkURL], private: true }) },
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

  if (params.mediaType === 'video') {
    items.push({ label: 'Picture in Picture', ...accel('Alt+P'), click: () => tab.togglePictureInPicture() })
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
      { label: `Search ${search.current().name} for “${truncate(text)}”`, click: () => shell.createTab({ url: searchUrl(text), openerId: tab.id }) },
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
    const extensionItems = shell.private ? [] : extensions.get()?.getContextMenuItems(wc, params) ?? []
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
  const otherGroups = [...shell.groups.values()].filter((group) => group.id !== tab.groupId)
  showMenu(shell, [
    { label: 'Reload', click: () => (tab.ensureLoaded(), wc.reload()) },
    { label: 'Duplicate', click: () => shell.duplicateTab(id) },
    { label: wc.isAudioMuted() ? 'Unmute Tab' : 'Mute Tab', click: () => (wc.setAudioMuted(!wc.isAudioMuted()), shell.tabChanged(tab)) },
    { label: 'Copy Address', enabled: !isNewTab(tab.url), click: () => clipboard.writeText(tab.url) },
    {
      label: favorites.has(tab.url) ? 'Remove from Favorites' : 'Add to Favorites',
      enabled: /^https?:/.test(tab.url),
      click: () => toggleFavorite(shell, tab),
    },
    { type: 'separator' },
    ...(tab.split
      ? [
          { label: 'Separate Split View', click: () => shell.unsplit(id) },
          { label: 'Swap Sides', click: () => shell.swapSplit(id) },
        ]
      : [
          {
            label: 'Open in Split View',
            enabled: shell.order.length > 1,
            click: () => shell.splitWith(id, shell.splitPartnerFor(id), 'right'),
          },
        ]),
    { label: 'Move to New Window', enabled: shell.order.length > 1, click: () => shell.moveToNewWindow(tab) },
    { type: 'separator' },
    { label: 'Add to New Group…', click: () => newGroupFor(shell, tab) },
    ...(otherGroups.length
      ? [{ label: 'Add to Group', submenu: otherGroups.map((group) => ({ label: group.name || 'Unnamed group', icon: groupDot(group.color), click: () => shell.setTabGroup(tab, group.id) })) }]
      : []),
    ...(tab.groupId != null ? [{ label: 'Remove from Group', click: () => shell.setTabGroup(tab, null) }] : []),
    { type: 'separator' },
    { label: 'Close Tab', ...accel('CmdOrCtrl+W'), click: () => shell.closeTab(id) },
    { label: 'Close Other Tabs', enabled: shell.order.length > 1, click: () => shell.closeOtherTabs(id) },
    { label: 'Close Tabs to the Right', enabled: index < shell.order.length - 1, click: () => shell.closeTabsToRight(id) },
    { type: 'separator' },
    { label: 'Reopen Closed Tab', ...accel('CmdOrCtrl+Shift+T'), enabled: shell.closedTabs.length > 0, click: () => shell.reopenClosedTab() },
  ], { x, y })
}

const GROUP_DOT_COLORS = { blue: '#4c9bff', purple: '#a78bfa', pink: '#f472b6', green: '#4ade80', orange: '#fb923c', red: '#f87171', yellow: '#facc15', gray: '#a1a1aa' }
const groupDot = (color) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="${GROUP_DOT_COLORS[color]}"/></svg>`)}`

async function askGroupName(shell, title, value, confirm) {
  const { button, values } = await require('./prompts').ask(shell, {
    title,
    fields: [{ id: 'name', label: 'Name', value, placeholder: 'Optional' }],
    buttons: [
      { id: 'cancel', label: 'Cancel', style: 'secondary' },
      { id: 'ok', label: confirm, style: 'primary' },
    ],
    cancelId: 'cancel',
  })
  return button === 'ok' ? String(values.name ?? '').trim().slice(0, 60) : null
}

async function newGroupFor(shell, tab) {
  const name = await askGroupName(shell, 'New tab group', '', 'Create')
  if (name == null || !shell.tabs.has(tab.id)) return
  shell.setTabGroup(tab, shell.addGroup({ name }).id)
}

/** Right-click on a group's label. */
function groupContextMenu(shell, id, x, y) {
  const group = shell.groups.get(id)
  if (!group) return
  showMenu(shell, [
    { label: group.collapsed ? 'Show Tabs' : 'Hide Tabs', click: () => shell.toggleGroup(id) },
    {
      label: 'Rename…',
      click: async () => {
        const name = await askGroupName(shell, 'Rename group', group.name, 'Save')
        if (name == null) return
        group.name = name
        shell.scheduleState()
      },
    },
    {
      label: 'Color',
      submenu: Object.keys(GROUP_DOT_COLORS).map((color) => ({
        label: color.charAt(0).toUpperCase() + color.slice(1),
        icon: groupDot(color),
        type: 'radio',
        checked: group.color === color,
        click: () => {
          group.color = color
          shell.scheduleState()
        },
      })),
    },
    { type: 'separator' },
    {
      label: 'New Tab in Group',
      click: () => {
        const members = shell.order.filter((each) => shell.tabs.get(each).groupId === id)
        shell.createTab({ groupId: id, index: shell.order.indexOf(members.at(-1)) + 1 })
      },
    },
    { label: 'Ungroup', click: () => shell.ungroup(id) },
    { label: 'Close Group', click: () => shell.closeGroup(id) },
  ], { x, y })
}

/** Right-click on the + button: the last 10 pages visited, then a way into full history. */
function newTabButtonMenu(shell, x, y) {
  if (shell.private) return showMenu(shell, [{ label: 'Private windows don’t keep history', enabled: false }], { x, y })
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

function faviconFor(url) {
  try {
    return FAVICON_URL.replace('%s', encodeURIComponent(new URL(url).hostname.replace(/^www\./, '')))
  } catch {
    return null
  }
}

/** Right-click on a favorite in the bar. */
function favoriteContextMenu(shell, url, x, y) {
  const favorite = favorites.list().find((f) => f.url === url)
  if (!favorite) return
  showMenu(shell, [
    { label: 'Open in New Tab', click: () => shell.createTab({ url }) },
    { label: 'Open in New Window', click: () => shell.newWindow({ urls: [url] }) },
    { label: 'Copy Address', click: () => clipboard.writeText(url) },
    { type: 'separator' },
    { label: 'Edit…', click: () => editFavorite(shell, favorite) },
    { label: 'Remove', click: () => favorites.remove(url) },
  ], { x, y })
}

async function editFavorite(shell, favorite) {
  const { button, values } = await require('./prompts').ask(shell, {
    title: 'Edit Favorite',
    origin: favorite.url,
    fields: [
      { id: 'title', label: 'Name', value: favorite.title },
      { id: 'url', label: 'Address', value: favorite.url },
    ],
    buttons: [
      { id: 'cancel', label: 'Cancel', style: 'secondary' },
      { id: 'save', label: 'Save', style: 'primary' },
    ],
    cancelId: 'cancel',
  })
  if (button !== 'save') return
  const url = resolveInput(values.url)
  const saved = favorites.update(favorite.url, { title: String(values.title ?? ''), url })
  if (!saved) {
    shell.sendEvent('flash', 'Favorites need a web address')
    shell.peek()
  }
}

/** The » button: favorites that don't fit in the bar. */
function favoritesOverflowMenu(shell, from, x, y) {
  const items = favorites.list().slice(from).map((f) => ({
    label: truncate(f.title || f.url, 48),
    icon: faviconFor(f.url),
    click: () => shell.activeTab()?.loadURL(f.url),
  }))
  if (items.length) showMenu(shell, items, { x, y })
}

/** Right-click in a text field of the browser's own UI, such as the address bar. */
async function inputContextMenu(shell, x, y, { hasSelection = false, isAddress = false } = {}) {
  const wc = shell.ui.webContents
  const pasted = await clipboard.readText().catch(() => '')
  const canPaste = pasted.trim().length > 0
  if (shell.closed) return
  const items = [
    { label: 'Cut', ...accel('CmdOrCtrl+X'), enabled: hasSelection, click: () => wc.cut() },
    { label: 'Copy', ...accel('CmdOrCtrl+C'), enabled: hasSelection, click: () => wc.copy() },
    { label: 'Paste', ...accel('CmdOrCtrl+V'), enabled: canPaste, click: () => wc.paste() },
  ]
  if (isAddress) {
    items.push({
      label: 'Paste and Go',
      enabled: canPaste,
      click: () => {
        shell.activeTab()?.navigate(pasted)
        shell.focusPage()
      },
    })
  }
  items.push({ type: 'separator' }, { label: 'Select All', ...accel('CmdOrCtrl+A'), click: () => wc.selectAll() })
  showMenu(shell, items, { x, y })
}

/** Actions from the ⋯ panel (the panel itself is drawn by the toolbar UI). */
function runAction(shell, action) {
  const tab = shell.activeTab()
  const actions = {
    'new-tab': () => shell.createTab(),
    'new-window': () => shell.newWindow(),
    'new-private-window': () => shell.constructor.create({ private: true }),
    'picture-in-picture': () => tab?.togglePictureInPicture(),
    screenshot: () => shell.saveScreenshot(),
    'toggle-sleep-tabs': () => require('./sleeping-tabs').setEnabled(!require('./sleeping-tabs').enabled()),
    'toggle-split-links': () => {
      const store = require('./store')
      store.set('splitLinks', store.get('splitLinks') === false)
      shell.constructor.all.forEach((each) => each.scheduleState())
    },
    'toggle-email-codes': () => {
      const store = require('./store')
      store.set('emailCodes', store.get('emailCodes') === false)
      shell.constructor.all.forEach((each) => each.scheduleState())
    },
    'clean-up-tabs': () => require('./tab-cleanup').run(shell).catch((err) => console.error('Could not clean up tabs:', err)),
    find: () => tab && shell.openFind(),
    'zoom-in': () => tab?.zoom(1),
    'zoom-out': () => tab?.zoom(-1),
    'zoom-reset': () => tab?.zoom(0),
    'toggle-autohide': () => shell.toggleFocusMode(),
    'toggle-fullscreen': () => shell.toggleFullScreen(),
    favorite: () => toggleFavorite(shell),
    'toggle-favorites-bar': () => toggleFavoritesBar(),
    'toggle-split': () => shell.toggleSplit(),
    'toggle-protection': () => shell.toggleProtection(),
    protection: () => openOrSelect(shell, PROTECTION_URL),
    'reopen-tab': () => shell.reopenClosedTab(),
    extensions: () => openOrSelect(shell, EXTENSIONS_URL),
    'web-store': () => (shell.private ? openOrSelect(shell, WEB_STORE_URL) : shell.createTab({ url: WEB_STORE_URL })),
    passwords: () => openOrSelect(shell, PASSWORDS_URL),
    history: () => openOrSelect(shell, HISTORY_URL),
    'downloads-folder': () => electronShell.openPath(app.getPath('downloads')),
    print: () => tab?.webContents.print(),
    devtools: () => tab?.toggleDevTools(),
    about: () => about(shell),
    setup: () => require('./setup').open(),
    'check-updates': () => require('./updater').checkNow(shell),
    quit: () => app.quit(),
  }
  if (Object.hasOwn(actions, action)) actions[action]()
}

function openOrSelect(from, url) {
  // These pages are about your normal browsing (its history, passwords and extensions), so that's where they open.
  const shell = from.private ? from.constructor.lastNormal() : from
  if (!shell) return from.constructor.create({ urls: [url] })
  if (from.private) shell.focus()
  for (const id of shell.order) {
    if (shell.tabs.get(id).url.startsWith(url)) return shell.selectTab(id)
  }
  const active = shell.activeTab()
  if (active && isNewTab(active.url)) active.loadURL(url)
  else shell.createTab({ url })
}

/** Adds the page to favorites, or removes it if it's already there. */
function toggleFavorite(shell, tab = shell.activeTab()) {
  if (!tab || !/^https?:/.test(tab.url)) return
  const removing = favorites.has(tab.url)
  if (removing) favorites.remove(tab.url)
  else favorites.add({ title: tab.title, url: tab.url })
  shell.sendEvent('flash', removing ? 'Removed from Favorites' : 'Added to Favorites')
  shell.peek()
}

function toggleFavoritesBar() {
  appearance.update({ favoritesBar: !appearance.get().favoritesBar })
}

function about(shell) {
  require('./prompts').ask(shell, {
    title: APP_NAME,
    message: `Version ${app.getVersion()}`,
    detail: `Chromium ${process.versions.chrome} · Electron ${process.versions.electron}\nSearch by ${search.current().name}`,
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
  groupContextMenu,
  runAction,
  selectMenuItem,
  toggleFavorite,
  toggleFavoritesBar,
  favoriteContextMenu,
  favoritesOverflowMenu,
  inputContextMenu,
  applicationMenu,
  openOrSelect,
}
