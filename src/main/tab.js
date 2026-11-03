const { WebContentsView } = require('electron')
const { TRANSPARENT } = require('./constants')
const { resolveInput, isInternal } = require('./url')
const history = require('./history')

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

class Tab {
  constructor(shell, { url, webContents, title, lazy = false, openerId = null } = {}) {
    this.shell = shell
    this.openerId = openerId
    this.view = webContents
      ? new WebContentsView({ webContents })
      : new WebContentsView({
          webPreferences: { sandbox: true, contextIsolation: true, plugins: true, spellcheck: true },
        })
    this.webContents = this.view.webContents
    this.id = this.webContents.id
    this.favicon = null
    this.loading = false
    this.pendingUrl = null
    this.pendingTitle = null

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
    return this.pendingUrl ?? this.webContents.getURL()
  }

  get title() {
    if (this.pendingTitle) return this.pendingTitle
    return this.webContents.getTitle() || this.url || 'New Tab'
  }

  loadURL(url) {
    this.pendingUrl = null
    this.pendingTitle = null
    this.applyBackground(url)
    // Load failures are reported through `did-fail-load`.
    this.webContents.loadURL(url).catch(() => {})
  }

  /** Lazily restored tabs only load once they're first shown. */
  ensureLoaded() {
    if (this.pendingUrl) this.loadURL(this.pendingUrl)
  }

  navigate(input) {
    const url = resolveInput(input)
    if (url) this.loadURL(url)
  }

  /** Internal pages are see-through; the web gets an opaque canvas like any other browser. */
  applyBackground(url) {
    this.view.setBackgroundColor(isInternal(url) ? TRANSPARENT : PAGE_BACKGROUND)
  }

  zoom(direction) {
    const wc = this.webContents
    if (direction === 0) return wc.setZoomFactor(1)
    const current = wc.getZoomFactor()
    const next =
      direction > 0
        ? ZOOM_STEPS.find((z) => z > current + 0.001)
        : ZOOM_STEPS.findLast((z) => z < current - 0.001)
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

    wc.on('page-title-updated', (_e, title) => {
      history.updateTitle(wc.getURL(), title)
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
      this.favicon = null
      this.applyBackground(url)
      history.record(url, wc.getTitle())
      changed()
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return
      history.record(url, wc.getTitle())
      changed()
    })
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: the user stopped the load or navigated away.
      if (!isMainFrame || code === -3 || isInternal(url)) return
      this.view.setBackgroundColor('#111113')
      wc.executeJavaScript(errorPageScript(url, code, description)).catch(() => {})
    })
    wc.on('audio-state-changed', changed)
    wc.on('zoom-changed', (_e, direction) => this.zoom(direction === 'in' ? 1 : -1))
    wc.on('found-in-page', (_e, result) => {
      if (this.shell.activeTab() !== this) return
      this.shell.sendEvent('found', { active: result.activeMatchOrdinal, matches: result.matches })
    })
    wc.on('enter-html-full-screen', () => this.shell.setHtmlFullscreen(true))
    wc.on('leave-html-full-screen', () => this.shell.setHtmlFullscreen(false))
    wc.on('context-menu', (_e, params) => require('./menus').pageContextMenu(this, params))
    wc.on('before-input-event', (event, input) => {
      if (require('./shortcuts').handle(this.shell, input)) event.preventDefault()
    })
    wc.on('render-process-gone', changed)
    wc.on('destroyed', () => this.shell.closeTab(this.id))

    wc.setWindowOpenHandler(({ disposition }) => {
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
    return {
      id: this.id,
      title: this.title,
      url: this.url,
      favicon: this.favicon,
      loading: this.loading,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      audible: wc.isCurrentlyAudible(),
      muted: wc.isAudioMuted(),
      zoom: Math.round(wc.getZoomFactor() * 100),
      crashed: wc.isCrashed(),
    }
  }

  destroy() {
    if (!this.webContents.isDestroyed()) this.webContents.close()
  }
}

module.exports = { Tab }
