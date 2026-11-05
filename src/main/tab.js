const { WebContentsView } = require('electron')
const { TRANSPARENT } = require('./constants')
const { resolveInput, isInternal } = require('./url')
const history = require('./history')
const blocker = require('./blocker')
const privacy = require('./privacy')

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
const PAGE_BACKGROUND = '#ffffff'

/** Renders a minimal dark error page into Chromium's (otherwise blank) error document. */
function errorPageScript(url, code, description) {
  const data = JSON.stringify({ url, code, description })
  return `(() => {
    const { url, code, description } = ${data};
    let host = url; try { host = new URL(url).host || url } catch {}
    document.title = host;
    document.documentElement.innerHTML = \`
      <style>
        html, body { margin: 0; height: 100%; background: #111113; color: #e8e8ea;
          font: 14px/1.5 system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif; }
        main { height: 100%; display: grid; place-content: center; text-align: center; gap: 6px; padding: 24px; }
        h1 { font-weight: 600; font-size: 22px; margin: 0 0 4px; }
        p { margin: 0; color: #8e8e93; max-width: 520px; }
        code { color: #636366; font-size: 12px; }
        button { margin-top: 18px; justify-self: center; padding: 8px 18px; border-radius: 9px; border: 0;
          background: #0a84ff; color: white; font: inherit; font-weight: 500; cursor: pointer; }
        button:hover { background: #2b95ff; }
      </style>
      <main>
        <h1>Can’t open this page</h1>
        <p></p>
        <code></code>
        <button>Try Again</button>
      </main>\`;
    document.querySelector('p').textContent = 'Glasswing couldn’t reach ' + host + '.';
    document.querySelector('code').textContent = description + ' (' + code + ')';
    document.querySelector('button').addEventListener('click', () => location.replace(url));
  })()`
}

/**
 * What a tab is recording. The page itself reports when it stops (src/preload/capture.js), but only
 * the top of the page can: a frame embedded in it stays marked as recording until the page changes.
 */
const noCapture = () => ({ page: { audio: false, video: false }, frames: { audio: false, video: false } })

class Tab {
  constructor(shell, { url, webContents, title, lazy = false, openerId = null } = {}) {
    this.shell = shell
    this.openerId = openerId
    this.view = webContents
      ? new WebContentsView({ webContents })
      : new WebContentsView({
          webPreferences: { session: shell.session, sandbox: true, contextIsolation: true, plugins: true, spellcheck: true },
        })
    this.webContents = this.view.webContents
    this.id = this.webContents.id
    this.favicon = null
    this.loading = false
    this.pendingUrl = null
    this.pendingTitle = null
    // Last known values, so a tab can still be described after its page is gone.
    this.lastUrl = ''
    this.lastTitle = ''
    this.crashPromptOpen = false
    this.split = null // { left, right, ratio }, shared with the tab on the other side
    this.capture = noCapture()

    this.view.setBackgroundColor(TRANSPARENT)
    this.bindEvents()

    if (url && lazy) {
      this.pendingUrl = url
      this.pendingTitle = title ?? null
    } else if (url) {
      this.loadURL(url)
    }
  }

  get url() {
    if (this.pendingUrl) return this.pendingUrl
    if (!this.webContents.isDestroyed()) this.lastUrl = this.webContents.getURL()
    return this.lastUrl
  }

  get title() {
    if (this.pendingTitle) return this.pendingTitle
    if (!this.webContents.isDestroyed()) this.lastTitle = this.webContents.getTitle()
    return this.lastTitle || this.url || 'New Tab'
  }

  loadURL(url) {
    this.pendingUrl = null
    this.pendingTitle = null
    this.applyBackground(url)
    // Load failures are reported through `did-fail-load`.
    this.webContents.loadURL(url).catch(() => {})
  }

  /** Lazily restored tabs load once they're first shown; crashed background tabs recover the same way. */
  ensureLoaded() {
    if (this.pendingUrl) this.loadURL(this.pendingUrl)
    else if (this.webContents.isCrashed()) this.recover()
  }

  recover() {
    const { url } = this
    if (url) this.loadURL(url)
  }

  /** Offers a way out of a page that's stopped answering. The card goes away by itself if it recovers. */
  async handleFrozenPage() {
    const { shell } = this
    if (this.frozenPromptOpen || !shell.visibleTabs().includes(this)) return
    this.frozenPromptOpen = true
    let host = this.url
    try {
      host = new URL(host).host || host
    } catch {}
    const { button } = await require('./prompts').ask(shell, {
      tag: `frozen-${this.id}`,
      title: 'This page isn’t responding',
      message: host,
      detail: 'You can wait for it, or reload it. Reloading loses anything you haven’t saved on the page.',
      buttons: [
        { id: 'wait', label: 'Wait', style: 'secondary' },
        { id: 'reload', label: 'Reload', style: 'primary' },
      ],
      cancelId: 'wait',
    })
    this.frozenPromptOpen = false
    if (button !== 'reload' || this.webContents.isDestroyed()) return
    this.restartingFrozenPage = true
    this.webContents.forcefullyCrashRenderer() // a frozen page can't be asked to reload; see render-process-gone
  }

  /** The page's process died. Offer to bring it back, unless it isn't on screen yet. */
  async handleCrash() {
    const { shell } = this
    this.loading = false
    shell.tabChanged(this)
    if (shell.activeTab() !== this || this.crashPromptOpen) return
    this.crashPromptOpen = true
    let host = this.url
    try {
      host = new URL(host).host || host
    } catch {}
    const { button } = await require('./prompts').ask(shell, {
      title: 'This page stopped working',
      message: host,
      buttons: [
        { id: 'close', label: 'Close Tab', style: 'secondary' },
        { id: 'reload', label: 'Reload', style: 'primary' },
      ],
      cancelId: 'dismiss',
    })
    this.crashPromptOpen = false
    if (this.webContents.isDestroyed()) return
    if (button === 'close') shell.closeTab(this.id)
    else if (button === 'reload') this.recover()
  }

  navigate(input) {
    const url = resolveInput(input)
    if (url) this.loadURL(url)
  }

  get usingCamera() {
    return this.capture.page.video || this.capture.frames.video
  }

  get usingMicrophone() {
    return this.capture.page.audio || this.capture.frames.audio
  }

  updateCapture(change) {
    const before = this.usingCamera || this.usingMicrophone
    change()
    // The icons are no use if the toolbar is hidden when a site starts recording.
    if (!before && (this.usingCamera || this.usingMicrophone)) this.shell.peek()
    this.shell.tabChanged(this)
  }

  /** The site was just given the camera or mic. It may not say which, so assume both. */
  captureAllowed(mediaTypes, isMainFrame) {
    const types = mediaTypes?.length ? mediaTypes : ['audio', 'video']
    this.updateCapture(() => {
      const side = isMainFrame ? this.capture.page : this.capture.frames
      for (const type of types) if (type === 'audio' || type === 'video') side[type] = true
    })
  }

  /** The page's own count of what it has running. */
  captureReported(audio, video) {
    this.updateCapture(() => {
      this.capture.page = { audio: audio > 0, video: video > 0 }
    })
  }

  captureEnded() {
    if (this.usingCamera || this.usingMicrophone) this.updateCapture(() => (this.capture = noCapture()))
  }

  /** Internal pages are see-through; the web gets an opaque canvas like any other browser. */
  applyBackground(url) {
    this.view.setBackgroundColor(isInternal(url) ? TRANSPARENT : PAGE_BACKGROUND)
  }

  zoom(direction) {
    const wc = this.webContents
    const current = wc.getZoomFactor()
    let next = 1
    if (direction > 0) next = ZOOM_STEPS.find((z) => z > current + 0.001)
    else if (direction < 0) next = ZOOM_STEPS.findLast((z) => z < current - 0.001)
    if (next) wc.setZoomFactor(next)
    this.shell.tabChanged(this)
  }

  toggleDevTools() {
    const wc = this.webContents
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'detach' })
  }

  bindEvents() {
    const wc = this.webContents
    const changed = () => this.shell.tabChanged(this)
    const recordVisit = (url) => {
      if (!this.shell.private) history.record(url, wc.getTitle())
    }

    wc.on('page-title-updated', (_e, title) => {
      if (!this.shell.private) history.updateTitle(wc.getURL(), title)
      changed()
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      this.favicon = favicons?.[0] ?? null
      changed()
    })
    wc.on('did-start-loading', () => {
      this.loading = true
      changed()
    })
    wc.on('did-stop-loading', () => {
      this.loading = false
      changed()
    })
    wc.on('did-navigate', (_e, url) => {
      privacy.loaded(url)
      this.favicon = null
      this.applyBackground(url)
      recordVisit(url)
      this.captureEnded()
      changed()
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return
      recordVisit(url)
      changed()
    })
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: the user stopped the load or navigated away.
      if (!isMainFrame || code === -3 || isInternal(url)) return
      const plainUrl = privacy.fallbackFor(url)
      if (plainUrl) {
        wc.loadURL(plainUrl).catch(() => {}) // failures come back through here
        return
      }
      this.view.setBackgroundColor('#111113')
      wc.executeJavaScript(errorPageScript(url, code, description)).catch(() => {})
    })
    wc.on('audio-state-changed', changed)
    wc.on('zoom-changed', (_e, direction) => this.zoom(direction === 'in' ? 1 : -1))
    wc.on('found-in-page', (_e, result) => {
      if (this.shell.activeTab() !== this) return
      this.shell.sendEvent('found', { active: result.activeMatchOrdinal, matches: result.matches })
    })
    // Clicking into the other side of a split view makes it the tab the toolbar is about.
    wc.on('focus', () => this.shell.paneFocused(this))
    wc.on('enter-html-full-screen', () => {
      this.shell.paneFocused(this)
      this.shell.setHtmlFullscreen(true)
    })
    wc.on('leave-html-full-screen', () => this.shell.setHtmlFullscreen(false))
    wc.on('context-menu', (_e, params) => require('./menus').pageContextMenu(this, params))
    wc.on('before-input-event', (event, input) => {
      if (require('./shortcuts').handle(this.shell, input)) event.preventDefault()
    })
    wc.on('render-process-gone', (_e, details) => {
      this.captureEnded()
      changed()
      if (this.restartingFrozenPage) {
        this.restartingFrozenPage = false
        this.recover()
        return
      }
      if (details.reason !== 'clean-exit' && !this.shell.closed && !this.shell.constructor.quitting) this.handleCrash()
    })
    wc.on('unresponsive', () => this.handleFrozenPage())
    wc.on('responsive', () => require('./prompts').closeTagged(`frozen-${this.id}`))
    wc.on('destroyed', () => this.shell.closeTab(this.id))
    // Websites can't send people to the browser's own pages.
    wc.on('will-navigate', (event) => {
      if (isInternal(event.url) && !isInternal(wc.getURL())) event.preventDefault()
    })

    wc.setWindowOpenHandler(({ disposition, url }) => {
      if (isInternal(url) && !isInternal(wc.getURL())) return { action: 'deny' }
      // Popups with window features (OAuth, payment flows) stay real windows so `window.opener` works.
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#ffffff' },
        }
      }
      // Everything else (target=_blank, middle-click, window.open without features) becomes a tab.
      return {
        action: 'allow',
        outlivesOpener: true,
        createWindow: (options) =>
          this.shell.createTab({
            webContents: options.webContents,
            active: disposition !== 'background-tab',
            openerId: this.id,
          }).webContents,
      }
    })
  }

  state() {
    const wc = this.webContents
    const alive = !wc.isDestroyed()
    return {
      id: this.id,
      title: this.title,
      url: this.url,
      favicon: this.favicon,
      loading: this.loading,
      canGoBack: alive && wc.navigationHistory.canGoBack(),
      canGoForward: alive && wc.navigationHistory.canGoForward(),
      audible: alive && wc.isCurrentlyAudible(),
      muted: alive && wc.isAudioMuted(),
      camera: alive && this.usingCamera,
      microphone: alive && this.usingMicrophone,
      zoom: alive ? Math.round(wc.getZoomFactor() * 100) : 100,
      crashed: alive && wc.isCrashed(),
      blocked: blocker.countsFor(this.id),
      split: this.split ? (this.split.left === this.id ? 'left' : 'right') : null,
      splitPartner: this.split ? (this.split.left === this.id ? this.split.right : this.split.left) : null,
    }
  }

  destroy() {
    if (!this.webContents.isDestroyed()) this.webContents.close()
  }
}

module.exports = { Tab }
