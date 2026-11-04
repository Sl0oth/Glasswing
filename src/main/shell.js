// A browser window: one transparent window, a stack of tab views, and the toolbar UI view on top.
//
//   ┌──────────────────────────── BrowserWindow (acrylic / vibrancy) ───┐
//   │ ui view (transparent, topmost) — floating toolbar, favorites,     │
//   │                                  find bar, dropdowns              │
//   │ active tab view                                                   │
//   └───────────────────────────────────────────────────────────────────┘
//
// A view catches clicks across its whole rectangle, even where it's transparent. So with auto-hide
// on, the UI view has no height at all until it's needed, and the pointer is watched from here
// rather than through an invisible strip that would sit on top of the page. It grows to the full
// window while a dropdown is open.
const { BrowserWindow, WebContentsView, screen } = require('electron')
const path = require('node:path')
const {
  APP_NAME,
  NEWTAB_URL,
  TOOLBAR_HEIGHT,
  FAVBAR_HEIGHT,
  FINDBAR_HEIGHT,
  SHADOW_ROOM,
  LOADING_STRIP,
  REVEAL_ZONE,
  REVEAL_ZONE_MAXIMIZED,
  POINTER_POLL_MS,
  CONCEAL_DELAY_MS,
  CONCEAL_ANIMATION_MS,
  PEEK_MS,
  SHOW_PAGE_WAIT_MS,
  SHOW_TIMEOUT_MS,
  SPLIT_GAP,
  SPLIT_MARGIN,
  SPLIT_MIN_RATIO,
  TRANSPARENT,
} = require('./constants')
const { Tab } = require('./tab')
const { isNewTab } = require('./url')
const extensions = require('./extensions')
const appearance = require('./appearance')
const favorites = require('./favorites')
const blocker = require('./blocker')
const search = require('./search')
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
  static recent = [] // most recently focused first: the closest thing to knowing which window is on top
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

  constructor({ urls, tabs, activeIndex = 0, bounds, maximized = false, splits, adoptTab, fullscreen } = {}) {
    this.tabs = new Map()
    this.order = []
    this.activeId = null
    this.lastActiveId = null
    this.shownTabs = [] // the tabs whose views are in the window: one, or two in split view
    this.splitArea = null
    this.tabDragging = false // one of this window's tabs is being dragged out
    this.dropHovering = false // a tab from another window is being held over this one
    this.dropIndex = null
    this.closedTabs = []
    this.revealed = false
    this.concealing = false // sliding away; the view stays tall until the animation ends
    this.concealTimer = null
    this.uiExpanded = false
    this.pagePressTab = null // the tab getting a press passed on from the toolbar view
    this.uiHold = false // the address bar is being edited
    this.peekUntil = 0
    this.pointerLeftAt = null
    this.floatingRects = [] // where the floating elements are, reported by the UI
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
      fullscreen: fullscreen ?? this.appearance.fullscreen,
      title: APP_NAME,
      icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
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
    BrowserShell.recent.unshift(this)
    this.bindWindowEvents()
    this.pointerTimer = setInterval(() => this.watchPointer(), POINTER_POLL_MS)

    if (adoptTab) {
      this.adoptTab(adoptTab)
    } else {
      const initial = tabs ?? (urls?.length ? urls.map((url) => ({ url })) : [{ url: NEWTAB_URL }])
      initial.forEach((t, i) => {
        // Restored tabs stay unloaded until selected, except the one that's visible.
        const lazy = Boolean(tabs) && i !== activeIndex
        this.createTab({ url: t.url, title: t.title, lazy, active: false })
      })
      const created = [...this.order]
      for (const s of Array.isArray(splits) ? splits : []) {
        const left = created[s?.left]
        const right = created[s?.right]
        if (left != null && right != null && left !== right) this.setSplit(left, right, s.ratio)
      }
      this.selectTab(created[Math.min(activeIndex, created.length - 1)] ?? created[0])
      this.syncViews() // the active tab may already have been shown, before its split was restored
    }

    let shown = false
    const show = () => {
      if (shown || this.win.isDestroyed()) return
      shown = true
      if (maximized) this.win.maximize()
      this.win.show()
      this.layout()
      if (isNewTab(this.activeTab()?.url)) this.focusAddressBar()
    }
    // Wait for every layer, so they don't pop in one at a time over the bare glass. A slow website
    // only gets a short wait: its page can finish loading with the window already up.
    let uiReady = false
    let backdropReady = false
    const showWhenReady = () => {
      if (!uiReady || !backdropReady) return
      const page = this.activeTab()?.webContents
      if (!page || page.isDestroyed() || !page.isLoading()) return show()
      page.once('did-stop-loading', show)
      setTimeout(show, SHOW_PAGE_WAIT_MS)
    }
    this.ui.webContents.once('did-finish-load', () => {
      uiReady = true
      showWhenReady()
    })
    this.win.webContents.on('did-finish-load', () => {
      this.sendBackdrop('appearance', this.appearance)
      this.layout()
      backdropReady = true
      showWhenReady()
    })
    setTimeout(show, SHOW_TIMEOUT_MS) // never leave a window hidden if something doesn't load
  }

  bindWindowEvents() {
    const win = this.win
    const relayout = () => this.layout()
    win.on('resize', relayout)
    win.on('maximize', () => (relayout(), this.scheduleState()))
    win.on('unmaximize', () => (relayout(), this.scheduleState()))
    win.on('enter-full-screen', () => {
      this.setRevealed(false)
      relayout()
      this.scheduleState()
    })
    win.on('leave-full-screen', () => {
      this.setRevealed(false)
      this.htmlFullscreen = false
      this.fullscreenForHtml = false
      relayout()
      this.scheduleState()
    })
    win.on('focus', () => {
      BrowserShell.focused = this
      BrowserShell.recent = [this, ...BrowserShell.recent.filter((s) => s !== this)]
      this.scheduleState()
    })
    win.on('blur', () => {
      // Switching windows mid-press: the release may never arrive, so don't leave the page waiting.
      if (this.pagePressTab) this.forwardMouse('mouseUp', this.pagePressAt.x, this.pagePressAt.y, 0, 1)
      this.scheduleState()
    })
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
      clearInterval(this.pointerTimer)
      clearTimeout(this.concealTimer)
      require('./prompts').cancelAll(this)
      BrowserShell.all.delete(this)
      BrowserShell.recent = BrowserShell.recent.filter((s) => s !== this)
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
    this.keepSplitsTogether()

    extensions.addTab(tab.webContents, this.win, this.activeTab()?.webContents)

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
    if (previous) this.lastActiveId = previous.id
    this.activeId = id
    this.syncViews()
    this.layout()

    extensions.tabSelected(tab.webContents)

    if (isNewTab(tab.url)) this.focusAddressBar()
    else if (this.win.isFocused()) tab.webContents.focus()
    this.scheduleState()
  }

  closeTab(id) {
    const tab = this.tabs.get(id)
    if (!tab || this.closed) return
    if (!isNewTab(tab.url)) {
      this.closedTabs.push({ url: tab.url, title: tab.title, index: this.order.indexOf(id) })
      if (this.closedTabs.length > 25) this.closedTabs.shift()
    }

    this.releaseTab(tab)

    try {
      extensions.get()?.removeTab(tab.webContents)
    } catch {}
    tab.destroy()

    this.closeIfEmpty()
    if (!this.closed) this.scheduleState()
  }

  /** Takes a tab out of this window, without closing its page. Another tab takes its place. */
  releaseTab(tab) {
    const id = tab.id
    const index = this.order.indexOf(id)
    const partner = this.partnerOf(tab)
    this.clearSplit(tab)
    this.order.splice(index, 1)
    this.tabs.delete(id)

    const wasShown = this.shownTabs.includes(tab)
    if (wasShown) {
      this.shownTabs = this.shownTabs.filter((t) => t !== tab)
      if (!this.win.isDestroyed()) this.win.contentView.removeChildView(tab.view)
    }
    if (this.lastActiveId === id) this.lastActiveId = null

    if (this.activeId === id) {
      this.activeId = null
      // Prefer the other half of a split, then the opener when closing a tab it just spawned.
      const opener = tab.openerId != null && this.tabs.has(tab.openerId) ? tab.openerId : null
      const next = partner?.id ?? opener ?? this.order[index] ?? this.order[index - 1]
      if (next != null) this.selectTab(next)
    } else if (wasShown) {
      this.layout()
    }
  }

  /** Like Safari: closing the last tab closes the window. */
  closeIfEmpty() {
    if (this.order.length === 0 && !this.win.isDestroyed()) this.win.close()
  }

  /** Brings a tab here from another window, page and all, so nothing reloads. */
  adoptTab(tab, index = null) {
    const from = tab.shell
    if (from === this) return
    from.releaseTab(tab)

    tab.shell = this
    tab.openerId = null
    this.tabs.set(tab.id, tab)
    const at = Number.isFinite(index) ? Math.max(0, Math.min(index, this.order.length)) : this.order.length
    this.order.splice(at, 0, tab.id)
    this.keepSplitsTogether()
    extensions.tabMoved(tab.webContents, this.win)

    this.selectTab(tab.id)
    this.peek()
    from.closeIfEmpty()
    if (!from.closed) from.scheduleState()
  }

  /** Gives a tab its own window, as a normal window even if this one is full screen. */
  moveToNewWindow(tab, near = null) {
    if (this.order.length < 2 || !this.tabs.has(tab.id)) return null
    const roomy = !this.win.isFullScreen() && !this.win.isMaximized()
    const [width, height] = roomy ? this.win.getSize() : [1100, 720]
    const point = near ?? screen.getCursorScreenPoint()
    const area = screen.getDisplayNearestPoint(point).workArea
    const size = { width: Math.min(width, area.width), height: Math.min(height, area.height) }
    const bounds = {
      ...size,
      x: Math.round(Math.max(area.x, Math.min(point.x - 120, area.x + area.width - size.width))),
      y: Math.round(Math.max(area.y, Math.min(point.y - 20, area.y + area.height - size.height))),
    }
    return BrowserShell.create({ adoptTab: tab, bounds, fullscreen: false })
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
    this.keepSplitsTogether()
    this.scheduleState()
  }

  // ── Split view ────────────────────────────────────────────────────────

  partnerOf(tab) {
    if (!tab?.split) return null
    return this.tabs.get(tab.split.left === tab.id ? tab.split.right : tab.split.left) ?? null
  }

  clearSplit(tab) {
    const partner = this.partnerOf(tab)
    tab.split = null
    if (partner) partner.split = null
  }

  /** The two sides of a split sit next to each other in the tab strip, left one first. */
  keepSplitsTogether() {
    for (const id of [...this.order]) {
      const split = this.tabs.get(id)?.split
      if (split?.left !== id) continue
      this.order.splice(this.order.indexOf(split.right), 1)
      this.order.splice(this.order.indexOf(id) + 1, 0, split.right)
    }
  }

  setSplit(leftId, rightId, ratio = 0.5) {
    const left = this.tabs.get(leftId)
    const right = this.tabs.get(rightId)
    if (!left || !right || left === right) return
    this.clearSplit(left)
    this.clearSplit(right)
    const r = Number.isFinite(ratio) ? ratio : 0.5
    const pair = { left: leftId, right: rightId, ratio: Math.min(1 - SPLIT_MIN_RATIO, Math.max(SPLIT_MIN_RATIO, r)) }
    left.split = pair
    right.split = pair
    this.keepSplitsTogether()
  }

  /** Who a tab would share the window with: what you're looking at, or failing that the last tab or a neighbor. */
  splitPartnerFor(id) {
    if (this.activeId !== id && this.tabs.has(this.activeId)) return this.activeId
    if (this.lastActiveId !== id && this.tabs.has(this.lastActiveId)) return this.lastActiveId
    const index = this.order.indexOf(id)
    return this.order[index + 1] ?? this.order[index - 1] ?? null
  }

  /** Shows `id` on one side of the window and `partnerId` on the other, with `id` in focus. */
  splitWith(id, partnerId, side = 'right') {
    if (id === partnerId || !this.tabs.has(id) || !this.tabs.has(partnerId)) return
    if (side === 'left') this.setSplit(id, partnerId)
    else this.setSplit(partnerId, id)
    if (this.activeId === id) this.syncViews()
    else this.selectTab(id)
    this.layout()
    this.scheduleState()
  }

  unsplit(id = this.activeId) {
    const tab = this.tabs.get(id)
    if (!tab?.split) return
    this.clearSplit(tab)
    this.syncViews()
    this.layout()
    this.scheduleState()
  }

  swapSplit(id = this.activeId) {
    const split = this.tabs.get(id)?.split
    if (!split) return
    ;[split.left, split.right] = [split.right, split.left]
    this.keepSplitsTogether()
    this.layout()
    this.scheduleState()
  }

  /** Split View from the menu or keyboard: on with the most recent tab, or a new one; off if it's on. */
  toggleSplit() {
    const active = this.activeTab()
    if (!active) return
    if (active.split) return this.unsplit(active.id)
    const partnerId = this.splitPartnerFor(active.id)
    if (partnerId != null) {
      this.splitWith(active.id, partnerId, 'left')
      return
    }
    const fresh = this.createTab({ active: false })
    this.splitWith(fresh.id, active.id, 'right')
  }

  /** The divider, dragged to `x` in window coordinates. */
  dragSplitDivider(x) {
    const split = this.activeTab()?.split
    if (!split || !this.splitArea || !Number.isFinite(x)) return
    const ratio = (x - this.splitArea.x) / this.splitArea.width
    split.ratio = Math.min(1 - SPLIT_MIN_RATIO, Math.max(SPLIT_MIN_RATIO, ratio))
    this.layout()
  }

  resetSplitDivider() {
    const split = this.activeTab()?.split
    if (!split) return
    split.ratio = 0.5
    this.layout()
  }

  /** Focus moved to the other side of the split, so that's the tab the toolbar is about now. */
  paneFocused(tab) {
    if (!tab.split || this.activeId === tab.id || !this.shownTabs.includes(tab)) return
    if (this.findOpen) this.closeFind({ focusPage: false })
    this.lastActiveId = this.activeId
    this.activeId = tab.id
    extensions.tabSelected(tab.webContents)
    this.layout()
    this.scheduleState()
  }

  visibleTabs() {
    const active = this.activeTab()
    if (!active) return []
    if (!active.split) return [active]
    return [this.tabs.get(active.split.left), this.tabs.get(active.split.right)].filter(Boolean)
  }

  /** Puts the visible tabs' views in the window and takes the others out. */
  syncViews() {
    if (this.win.isDestroyed()) return
    const next = this.visibleTabs()
    for (const tab of this.shownTabs) {
      if (!next.includes(tab)) this.win.contentView.removeChildView(tab.view)
    }
    for (const tab of next) {
      this.win.contentView.addChildView(tab.view)
      tab.ensureLoaded()
    }
    this.win.contentView.addChildView(this.ui) // keep the toolbar on top
    this.shownTabs = next
  }

  // ── Ad and tracker blocking ───────────────────────────────────────────

  /** Blocking only changes what a page loads from now on, so the page on screen starts over. */
  reloadForProtection() {
    const tab = this.activeTab()
    if (tab && /^https?:/.test(tab.url)) tab.webContents.reload()
  }

  setProtection(partial) {
    blocker.set(partial)
    this.reloadForProtection()
  }

  toggleProtectionForSite() {
    blocker.toggleSite(this.activeTab()?.url)
    this.reloadForProtection()
  }

  toggleProtection() {
    const on = blocker.toggleAll()
    this.sendEvent('flash', on ? 'Ad and tracker blocking on' : 'Ad and tracker blocking off')
    this.peek()
    this.reloadForProtection()
  }

  // ── Dragging a tab out ────────────────────────────────────────────────

  setTabDragging(on) {
    this.tabDragging = Boolean(on)
  }

  /** A tab from another window is held over this one, at `x` (null when it leaves). */
  setDropHover(x) {
    this.dropHovering = x != null
    if (x == null) this.dropIndex = null
    if (this.dropHovering && this.isChromeHidden()) this.setRevealed(true)
    this.sendEvent('tab-drop-hover', x)
  }

  selectRelative(delta) {
    const index = this.order.indexOf(this.activeId)
    const next = this.order[(index + delta + this.order.length) % this.order.length]
    this.selectTab(next)
    this.peek()
  }

  selectIndex(n) {
    const id = n === 9 ? this.order.at(-1) : this.order[n - 1]
    if (id == null) return
    this.selectTab(id)
    this.peek()
  }

  tabChanged(tab) {
    if (!this.tabs.has(tab.id)) return
    // The active page decides whether the favorites bar and the loading line take up room.
    if (tab.id === this.activeId) this.layout()
    this.scheduleState()
  }

  favoritesChanged(list) {
    this.sendEvent('favorites', list)
    this.layout()
    this.scheduleState()
    // Open new tab pages show the same list. They have no preload, so nudge them directly.
    for (const tab of this.tabs.values()) {
      if (tab.pendingUrl || tab.webContents.isDestroyed() || !isNewTab(tab.url)) continue
      tab.webContents.executeJavaScript('window.dispatchEvent(new Event("favorites-changed"))').catch(() => {})
    }
  }

  // ── Chrome / layout ───────────────────────────────────────────────────

  isChromeHidden() {
    return this.appearance.autoHide
  }

  /** The favorites bar is left out on the new tab page, which already shows the same favorites. */
  favoritesBarVisible() {
    return this.appearance.favoritesBar && favorites.list().length > 0 && !isNewTab(this.activeTab()?.url)
  }

  chromeHeight() {
    return TOOLBAR_HEIGHT + (this.favoritesBarVisible() ? FAVBAR_HEIGHT : 0) + (this.findOpen ? FINDBAR_HEIGHT : 0)
  }

  layout() {
    if (this.win.isDestroyed()) return
    const [width, height] = this.win.getContentSize()
    const tab = this.activeTab()

    if (this.htmlFullscreen) {
      tab?.view.setBorderRadius(0)
      tab?.view.setBounds({ x: 0, y: 0, width, height })
      for (const other of this.shownTabs) {
        if (other !== tab) other.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      }
      // Prompts and right-click menus still have to appear over a full-screen video.
      this.ui.setBounds({ x: 0, y: 0, width, height: this.uiExpanded ? height : 0 })
      return
    }

    // With the toolbar auto-hidden, the page is the only thing on screen (edge to edge) and the
    // toolbar's elements float over it when revealed. Otherwise the page is a rounded card inset
    // into the tint, below the elements.
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
    const panes = this.visibleTabs()
    if (panes.length === 2) {
      this.layoutSplit(panes, card, hidden)
    } else {
      this.splitArea = null
      tab?.view.setBorderRadius(radius)
      tab?.view.setBounds(card)
      this.sendBackdrop('layout', { card, radius, split: null })
    }

    let uiHeight = chrome
    if (hidden) {
      // A press passed on to the page has to stay here to hear about its release.
      if (this.revealed || this.concealing || this.pagePressTab) uiHeight = chrome + SHADOW_ROOM
      else uiHeight = tab?.loading ? LOADING_STRIP : 0
    }
    if (this.uiExpanded) uiHeight = height
    this.ui.setBounds({ x: 0, y: 0, width, height: uiHeight })
  }

  layoutSplit([left, right], card, hidden) {
    const margin = hidden ? SPLIT_MARGIN : 0
    const area = {
      x: card.x + margin,
      y: card.y + margin,
      width: Math.max(0, card.width - margin * 2),
      height: Math.max(0, card.height - margin * 2),
    }
    const radius = this.appearance.radius
    const leftWidth = Math.round((area.width - SPLIT_GAP) * left.split.ratio)
    const leftRect = { x: area.x, y: area.y, width: leftWidth, height: area.height }
    const rightRect = {
      x: area.x + leftWidth + SPLIT_GAP,
      y: area.y,
      width: Math.max(0, area.width - leftWidth - SPLIT_GAP),
      height: area.height,
    }
    left.view.setBorderRadius(radius)
    left.view.setBounds(leftRect)
    right.view.setBorderRadius(radius)
    right.view.setBounds(rightRect)
    this.splitArea = area
    this.sendBackdrop('layout', {
      card: area,
      radius,
      split: {
        left: leftRect,
        right: rightRect,
        active: this.activeId === left.id ? 'left' : 'right',
        divider: { x: leftRect.x + leftRect.width, y: area.y, width: SPLIT_GAP, height: area.height },
      },
    })
  }

  applyAppearance(next) {
    const previous = this.appearance
    this.appearance = next
    if (isWin && next.material !== previous.material) this.win.setBackgroundMaterial(next.material)
    if (next.fullscreen !== previous.fullscreen && !this.htmlFullscreen) this.win.setFullScreen(next.fullscreen)
    if (next.autoHide !== previous.autoHide) {
      clearTimeout(this.concealTimer)
      this.revealed = false
      this.concealing = false
    }
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

  setHold(hold) {
    this.uiHold = Boolean(hold)
  }

  setFloatingRects(rects) {
    this.floatingRects = Array.isArray(rects) ? rects : []
  }

  /** Passes on a press in an empty part of the toolbar view to the page underneath it. */
  forwardMouse(type, x, y, button, clickCount) {
    if (![x, y, button, clickCount].every(Number.isFinite)) return
    const contains = ({ x: left, y: top, width, height }) => x >= left && x < left + width && y >= top && y < top + height
    if (type === 'mouseDown') this.pagePressTab = this.visibleTabs().find((tab) => contains(tab.view.getBounds())) ?? null
    this.pagePressAt = { x, y }

    const tab = this.pagePressTab
    if (tab && !tab.webContents.isDestroyed()) {
      const bounds = tab.view.getBounds()
      const event = { x: x - bounds.x, y: y - bounds.y, button: ['left', 'middle', 'right'][button] ?? 'left', clickCount }
      if (type === 'mouseDown') {
        tab.webContents.focus()
        tab.webContents.sendInputEvent({ ...event, type: 'mouseMove' })
      }
      // Without this, a page reads a move during a press as a move with nothing held: no text selecting.
      const held = type === 'mouseMove' ? { modifiers: [`${event.button}ButtonDown`] } : {}
      tab.webContents.sendInputEvent({ ...event, ...held, type })
    }

    if (type === 'mouseUp') {
      this.pagePressTab = null
      this.setRevealed(false) // the person has gone back to the page
      this.layout()
    }
  }

  setRevealed(revealed) {
    const next = Boolean(revealed)
    if (next === this.revealed) return
    this.revealed = next
    this.pointerLeftAt = null
    clearTimeout(this.concealTimer)
    this.concealing = !next
    if (!next) {
      // Keep the view tall until the elements have finished sliding away.
      this.concealTimer = setTimeout(() => {
        this.concealing = false
        this.layout()
      }, CONCEAL_ANIMATION_MS)
    }
    if (isMac && !this.win.isDestroyed()) this.win.setWindowButtonVisibility(next || !this.isChromeHidden())
    this.layout()
    this.scheduleState()
  }

  /** Shows the toolbar briefly, for changes that happen while it's out of sight. */
  peek() {
    if (!this.isChromeHidden()) return
    this.peekUntil = Date.now() + PEEK_MS
    this.setRevealed(true)
  }

  /** Things that need the toolbar on screen whatever the pointer is doing. */
  mustShowChrome() {
    return (
      this.uiHold ||
      this.findOpen ||
      this.tabDragging ||
      this.dropHovering ||
      Date.now() < this.peekUntil ||
      isNewTab(this.activeTab()?.url) // nothing to cover, and it's where people look for the address bar
    )
  }

  isPointerOverFloating(x, y) {
    const margin = 8
    return this.floatingRects.some(
      (r) => x >= r.x - margin && x <= r.x + r.width + margin && y >= r.y - margin && y <= r.y + r.height + margin,
    )
  }

  /** Auto-hide: brings the toolbar down at the top edge, and sends it away once it's not in use. */
  watchPointer() {
    if (this.closed || this.win.isDestroyed() || !this.isChromeHidden() || this.htmlFullscreen) return
    if (!this.win.isVisible() || this.win.isMinimized() || this.pagePressTab) return

    if (this.mustShowChrome()) {
      this.pointerLeftAt = null
      this.setRevealed(true)
      return
    }
    if (this.uiExpanded) {
      this.pointerLeftAt = null // a dropdown is open; the countdown starts over when it closes
      return
    }

    const cursor = screen.getCursorScreenPoint()
    const bounds = this.win.getContentBounds()
    const x = cursor.x - bounds.x
    const y = cursor.y - bounds.y
    const insideX = x >= 0 && x < bounds.width
    const zone = this.win.isMaximized() ? REVEAL_ZONE_MAXIMIZED : REVEAL_ZONE
    const atTopEdge = insideX && y >= 0 && y <= zone

    if (!this.revealed) {
      if (atTopEdge) this.setRevealed(true)
      return
    }

    if (atTopEdge || this.isPointerOverFloating(x, y)) {
      this.pointerLeftAt = null
      return
    }
    this.pointerLeftAt ??= Date.now()
    if (Date.now() - this.pointerLeftAt >= CONCEAL_DELAY_MS) this.setRevealed(false)
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
    this.scheduleState()
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
    if (this.isChromeHidden()) this.setRevealed(true)
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
      toolbarAway: this.htmlFullscreen || (this.isChromeHidden() && !this.revealed),
      focusMode: this.appearance.autoHide,
      fullscreen: this.win.isFullScreen(),
      maximized: this.win.isMaximized(),
      focused: this.win.isFocused(),
      findOpen: this.findOpen,
      favoritesBar: this.favoritesBarVisible(),
      favoritesBarEnabled: this.appearance.favoritesBar,
      protection: blocker.stateFor(this.activeTab()?.url),
      search: (({ name, host, path: searchPath, param }) => ({ name, host, path: searchPath, param }))(search.current()),
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
      splits: this.order
        .filter((id) => this.tabs.get(id).split?.left === id)
        .map((id) => {
          const { right, ratio } = this.tabs.get(id).split
          return { left: this.order.indexOf(id), right: this.order.indexOf(right), ratio }
        }),
    }
  }
}

module.exports = { BrowserShell }
