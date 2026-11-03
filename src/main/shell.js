// A browser window: one transparent window, a stack of tab views, and the toolbar UI view on top.
//
//   ┌──────────────────────────── BrowserWindow (acrylic / vibrancy) ───┐
//   │ ui view (transparent, topmost) — toolbar, find bar, dropdowns     │
//   │ active tab view                                                   │
//   └───────────────────────────────────────────────────────────────────┘
//
// The UI view is normally just as tall as the toolbar. It temporarily grows to the full window
// while a dropdown is open, and shrinks to a thin reveal strip in focus mode / full screen.
const { BrowserWindow, WebContentsView, screen } = require('electron')
const path = require('node:path')
const {
  APP_NAME,
  NEWTAB_URL,
  TOOLBAR_HEIGHT,
  FINDBAR_HEIGHT,
  REVEAL_STRIP,
  TRANSPARENT,
} = require('./constants')
const { Tab } = require('./tab')
const { isNewTab } = require('./url')
const extensions = require('./extensions')
const appearance = require('./appearance')
const store = require('./store')

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

function boundsAreVisible(bounds) {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const x = Math.max(a.x, bounds.x)
    const y = Math.max(a.y, bounds.y)
    return Math.min(a.x + a.width, bounds.x + bounds.width) - x > 100 &&
      Math.min(a.y + a.height, bounds.y + bounds.height) - y > 60
  })
}

class BrowserShell {
  static all = new Set()
  static focused = null
  static quitting = false

  static create(options) {
    return new BrowserShell(options)
  }

  static lastFocused() {
    if (BrowserShell.focused && BrowserShell.all.has(BrowserShell.focused)) return BrowserShell.focused
    return [...BrowserShell.all].at(-1) ?? null
  }

  static fromWindow(win) {
    for (const shell of BrowserShell.all) if (shell.win === win) return shell
    return null
  }

  static fromUi(webContents) {
    for (const shell of BrowserShell.all) if (shell.ui.webContents === webContents) return shell
    return null
  }

  /** Finds the shell owning a tab or the toolbar UI. */
  static fromWebContents(webContents) {
    if (!webContents) return null
    for (const shell of BrowserShell.all) {
      if (shell.ui.webContents === webContents || shell.tabs.has(webContents.id)) return shell
    }
    return null
  }

  static saveSession() {
    const windows = [...BrowserShell.all].map((shell) => shell.serialize())
    store.set('session', { windows })
  }

  constructor({ urls, tabs, activeIndex = 0, bounds, maximized = false } = {}) {
    this.tabs = new Map()
    this.order = []
    this.activeId = null
    this.closedTabs = []
    this.revealed = false
    this.uiExpanded = false
    this.findOpen = false
    this.htmlFullscreen = false
    this.fullscreenForHtml = false
    this.stateQueued = false
    this.closed = false

    this.appearance = appearance.get()
    const useBounds = bounds && boundsAreVisible(bounds) ? bounds : { width: 1280, height: 820 }

    this.win = new BrowserWindow({
      ...useBounds,
      minWidth: 480,
      minHeight: 320,
      show: false,
      fullscreen: this.appearance.fullscreen,
      title: APP_NAME,
      titleBarStyle: 'hidden',
      backgroundColor: process.platform === 'linux' ? '#161618' : TRANSPARENT,
      ...(isWin && { backgroundMaterial: this.appearance.material }),
      ...(isMac && {
        vibrancy: 'under-window',
        visualEffectState: 'active',
        trafficLightPosition: { x: 16, y: 16 },
      }),
      // The window's own page is the tinted backdrop behind the toolbar and the page card.
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'backdrop.js'),
        sandbox: true,
        contextIsolation: true,
      },
    })
    this.win.webContents.loadURL('glasswing://ui/backdrop.html')

    this.ui = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'ui.js'),
        // The preload needs `require` for the extension toolbar (<browser-action-list>).
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    })
    this.ui.setBackgroundColor(TRANSPARENT)
    this.win.contentView.addChildView(this.ui)
    this.ui.webContents.on('before-input-event', (event, input) => {
      if (require('./shortcuts').handle(this, input)) event.preventDefault()
    })
    this.ui.webContents.loadURL('glasswing://ui/index.html')

    BrowserShell.all.add(this)
    BrowserShell.focused = this
    this.bindWindowEvents()

    const initial = tabs ?? (urls?.length ? urls.map((url) => ({ url })) : [{ url: NEWTAB_URL }])
    initial.forEach((t, i) => {
      // Restored tabs stay unloaded until selected, except the one that's visible.
      const lazy = Boolean(tabs) && i !== activeIndex
      this.createTab({ url: t.url, title: t.title, lazy, active: false })
    })
    this.selectTab(this.order[Math.min(activeIndex, this.order.length - 1)] ?? this.order[0])

    let shown = false
    const show = () => {
      if (shown || this.win.isDestroyed()) return
      shown = true
      if (maximized) this.win.maximize()
      this.win.show()
      this.layout()
      if (isNewTab(this.activeTab()?.url)) this.focusAddressBar()
    }
    this.ui.webContents.once('did-finish-load', show)
    this.win.webContents.on('did-finish-load', () => {
      this.sendBackdrop('appearance', this.appearance)
      this.layout()
    })
    setTimeout(show, 1500)
  }

  bindWindowEvents() {
    const win = this.win
    const relayout = () => this.layout()
    win.on('resize', relayout)
    win.on('maximize', () => (relayout(), this.scheduleState()))
    win.on('unmaximize', () => (relayout(), this.scheduleState()))
    win.on('enter-full-screen', () => {
      this.revealed = false
      relayout()
      this.scheduleState()
    })
    win.on('leave-full-screen', () => {
      this.revealed = false
      this.htmlFullscreen = false
      this.fullscreenForHtml = false
      relayout()
      this.scheduleState()
    })
    win.on('focus', () => {
      BrowserShell.focused = this
      this.scheduleState()
    })
    win.on('blur', () => this.scheduleState())
    // Mouse back/forward buttons on Windows.
    win.on('app-command', (_e, command) => {
      const tab = this.activeTab()
      if (command === 'browser-backward') tab?.webContents.navigationHistory.goBack()
      if (command === 'browser-forward') tab?.webContents.navigationHistory.goForward()
    })
    win.on('close', () => {
      if (!BrowserShell.quitting && BrowserShell.all.size === 1) BrowserShell.saveSession()
    })
    win.on('closed', () => {
      this.closed = true
      require('./prompts').cancelAll(this)
      BrowserShell.all.delete(this)
      if (BrowserShell.focused === this) BrowserShell.focused = null
      const tabs = [...this.tabs.values()]
      this.tabs.clear()
      for (const tab of tabs) tab.destroy()
      if (!this.ui.webContents.isDestroyed()) this.ui.webContents.close()
    })
  }

  // ── Tabs ──────────────────────────────────────────────────────────────

  activeTab() {
    return this.tabs.get(this.activeId) ?? null
  }

  createTab({ url, webContents, title, active = true, lazy = false, openerId = null, index } = {}) {
    const tab = new Tab(this, {
      url: webContents ? undefined : (url ?? NEWTAB_URL),
      webContents,
      title,
      lazy,
      openerId,
    })
    this.tabs.set(tab.id, tab)

    let at = index ?? this.order.length
    if (index == null && openerId != null) {
      // Like Safari/Chrome: links open right after their opener, in order.
      at = this.order.indexOf(openerId)
      if (at >= 0) {
        at += 1
        while (at < this.order.length && this.tabs.get(this.order[at])?.openerId === openerId) at += 1
      } else {
        at = this.order.length
      }
    }
    this.order.splice(at, 0, tab.id)

    extensions.get()?.addTab(tab.webContents, this.win)

    if (active || (this.activeId == null && !lazy)) this.selectTab(tab.id)
    else this.scheduleState()
    return tab
  }

  selectTab(id) {
    const tab = this.tabs.get(id)
    if (!tab) return
    const previous = this.activeTab()
    if (previous === tab) return

    if (this.findOpen) this.closeFind({ focusPage: false })
    this.activeId = id
    if (previous) this.win.contentView.removeChildView(previous.view)
    this.win.contentView.addChildView(tab.view)
    this.win.contentView.addChildView(this.ui) // keep the toolbar on top
    tab.ensureLoaded()
    this.layout()

    extensions.get()?.selectTab(tab.webContents)

    if (isNewTab(tab.url)) this.focusAddressBar()
    else if (this.win.isFocused()) tab.webContents.focus()
    this.scheduleState()
  }

  closeTab(id) {
    const tab = this.tabs.get(id)
    if (!tab || this.closed) return
    const index = this.order.indexOf(id)
    this.order.splice(index, 1)
    this.tabs.delete(id)

    if (!isNewTab(tab.url)) {
      this.closedTabs.push({ url: tab.url, title: tab.title, index })
      if (this.closedTabs.length > 25) this.closedTabs.shift()
    }

    if (this.activeId === id) {
      this.activeId = null
      if (!this.win.isDestroyed()) this.win.contentView.removeChildView(tab.view)
      // Prefer returning to the opener when closing a tab it just spawned.
      const opener = tab.openerId != null && this.tabs.has(tab.openerId) ? tab.openerId : null
      const next = opener ?? this.order[index] ?? this.order[index - 1]
      if (next != null) this.selectTab(next)
    }

    try {
      extensions.get()?.removeTab(tab.webContents)
    } catch {}
    tab.destroy()

    // Like Safari: closing the last tab closes the window.
    if (this.order.length === 0) {
      if (!this.win.isDestroyed()) this.win.close()
      return
    }
    this.scheduleState()
  }

  closeOtherTabs(id) {
    for (const other of [...this.order]) if (other !== id) this.closeTab(other)
  }

  closeTabsToRight(id) {
    const index = this.order.indexOf(id)
    for (const other of this.order.slice(index + 1)) this.closeTab(other)
  }

  duplicateTab(id) {
    const tab = this.tabs.get(id)
    if (!tab) return
    this.createTab({ url: tab.url, index: this.order.indexOf(id) + 1 })
  }

  reopenClosedTab() {
    const last = this.closedTabs.pop()
    if (last) this.createTab({ url: last.url, index: Math.min(last.index, this.order.length) })
  }

  moveTab(id, toIndex) {
    const from = this.order.indexOf(id)
    if (from < 0) return
    this.order.splice(from, 1)
    this.order.splice(Math.max(0, Math.min(toIndex, this.order.length)), 0, id)
    this.scheduleState()
  }

  selectRelative(delta) {
    const index = this.order.indexOf(this.activeId)
    const next = this.order[(index + delta + this.order.length) % this.order.length]
    this.selectTab(next)
  }

  selectIndex(n) {
    const id = n === 9 ? this.order.at(-1) : this.order[n - 1]
    if (id != null) this.selectTab(id)
  }

  tabChanged(tab) {
    if (this.tabs.has(tab.id)) this.scheduleState()
  }

  // ── Chrome / layout ───────────────────────────────────────────────────

  isChromeHidden() {
    return this.appearance.autoHide
  }

  chromeHeight() {
    return TOOLBAR_HEIGHT + (this.findOpen ? FINDBAR_HEIGHT : 0)
  }

  layout() {
    if (this.win.isDestroyed()) return
    const [width, height] = this.win.getContentSize()
    const tab = this.activeTab()

    if (this.htmlFullscreen) {
      tab?.view.setBorderRadius(0)
      tab?.view.setBounds({ x: 0, y: 0, width, height })
      this.ui.setBounds({ x: 0, y: 0, width, height: 0 })
      return
    }

    // With the toolbar auto-hidden, the page is the only thing on screen (edge to edge) and the
    // toolbar floats over it when revealed. Otherwise the page is a rounded card inset into the tint.
    const hidden = this.isChromeHidden()
    const gap = hidden ? 0 : this.appearance.gap
    const radius = hidden ? 0 : this.appearance.radius
    const chrome = this.chromeHeight()
    const top = hidden ? 0 : chrome
    const card = {
      x: gap,
      y: top,
      width: Math.max(0, width - gap * 2),
      height: Math.max(0, height - top - gap),
    }
    tab?.view.setBorderRadius(radius)
    tab?.view.setBounds(card)
    this.sendBackdrop('layout', { card, radius })

    let uiHeight = hidden ? (this.revealed ? chrome : REVEAL_STRIP) : chrome
    if (this.uiExpanded) uiHeight = height
    this.ui.setBounds({ x: 0, y: 0, width, height: uiHeight })
  }

  applyAppearance(next) {
    const previous = this.appearance
    this.appearance = next
    if (isWin && next.material !== previous.material) this.win.setBackgroundMaterial(next.material)
    if (next.fullscreen !== previous.fullscreen && !this.htmlFullscreen) this.win.setFullScreen(next.fullscreen)
    if (next.autoHide !== previous.autoHide) this.revealed = false
    this.layout()
    this.sendBackdrop('appearance', next)
    this.sendEvent('appearance', next)
    this.scheduleState()
  }

  sendBackdrop(type, payload) {
    const wc = this.win.webContents
    if (!wc.isDestroyed()) wc.send('backdrop', type, payload)
  }

  setExpanded(expanded) {
    this.uiExpanded = Boolean(expanded)
    this.layout()
  }

  setRevealed(revealed) {
    this.revealed = Boolean(revealed)
    this.layout()
    this.scheduleState()
  }

  /** Auto-hide toolbar on/off. Remembered, and applies to every window. */
  toggleFocusMode() {
    appearance.update({ autoHide: !this.appearance.autoHide })
  }

  toggleFullScreen() {
    this.win.setFullScreen(!this.win.isFullScreen())
  }

  setHtmlFullscreen(on) {
    this.htmlFullscreen = on
    if (on && !this.win.isFullScreen()) {
      this.fullscreenForHtml = true
      this.win.setFullScreen(true)
    } else if (!on && this.fullscreenForHtml) {
      this.fullscreenForHtml = false
      this.win.setFullScreen(false)
    }
    this.layout()
  }

  focusAddressBar() {
    if (this.isChromeHidden()) this.setRevealed(true)
    this.ui.webContents.focus()
    this.sendEvent('focus-address')
  }

  focusPage() {
    this.activeTab()?.webContents.focus()
  }

  // ── Find in page ──────────────────────────────────────────────────────

  openFind() {
    this.findOpen = true
    if (this.isChromeHidden()) this.revealed = true
    this.layout()
    this.scheduleState()
    this.ui.webContents.focus()
    this.sendEvent('find-open')
  }

  closeFind({ focusPage = true } = {}) {
    this.findOpen = false
    const wc = this.activeTab()?.webContents
    if (wc && !wc.isDestroyed()) wc.stopFindInPage('keepSelection')
    this.layout()
    this.scheduleState()
    if (focusPage) this.focusPage()
  }

  find(text, { forward = true, newSession = true } = {}) {
    const wc = this.activeTab()?.webContents
    if (!wc) return
    if (!text) {
      wc.stopFindInPage('clearSelection')
      this.sendEvent('found', { active: 0, matches: 0 })
      return
    }
    wc.findInPage(text, { forward, findNext: newSession })
  }

  // ── UI messaging ──────────────────────────────────────────────────────

  getState() {
    return {
      tabs: this.order.map((id) => this.tabs.get(id).state()),
      activeId: this.activeId,
      chromeHidden: this.isChromeHidden(),
      revealed: this.revealed,
      focusMode: this.appearance.autoHide,
      fullscreen: this.win.isFullScreen(),
      maximized: this.win.isMaximized(),
      focused: this.win.isFocused(),
      findOpen: this.findOpen,
    }
  }

  scheduleState() {
    if (this.stateQueued) return
    this.stateQueued = true
    setImmediate(() => {
      this.stateQueued = false
      if (this.win.isDestroyed() || this.ui.webContents.isDestroyed()) return
      this.ui.webContents.send('ui:state', this.getState())
    })
  }

  sendEvent(type, payload) {
    if (this.ui.webContents.isDestroyed()) return
    this.ui.webContents.send('ui:event', type, payload)
  }

  focus() {
    if (this.win.isMinimized()) this.win.restore()
    this.win.focus()
  }

  serialize() {
    return {
      bounds: this.win.getNormalBounds(),
      maximized: this.win.isMaximized(),
      active: Math.max(0, this.order.indexOf(this.activeId)),
      tabs: this.order.map((id) => {
        const tab = this.tabs.get(id)
        return { url: tab.url || NEWTAB_URL, title: tab.title }
      }),
    }
  }
}

module.exports = { BrowserShell }
