const { WebContentsView, webContents: allWebContents } = require('electron')
const { TRANSPARENT } = require('./constants')
const { resolveInput, isInternal } = require('./url')
const history = require('./history')
const blocker = require('./blocker')
const privacy = require('./privacy')
const certificates = require('./certificates')

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
const PAGE_BACKGROUND = '#ffffff'

/** Renders a minimal dark error page into Chromium's (otherwise blank) error document. */
function errorPageScript(url, code, description, { certificate = false } = {}) {
  const data = JSON.stringify({ url, code, description, certificate })
  return `(() => {
    const { url, code, description, certificate } = ${data};
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
    document.querySelector('p').textContent = certificate
      ? host + ' uses a security certificate it made itself. Press Try Again to choose whether to open it anyway.'
      : 'Glasswing couldn’t reach ' + host + '.';
    if (certificate) document.querySelector('h1').textContent = 'This device’s certificate isn’t trusted';
    document.querySelector('code').textContent = description + ' (' + code + ')';
    document.querySelector('button').addEventListener('click', () => location.replace(url));
  })()`
}

/**
 * What a tab is recording. The page itself reports when it stops (src/preload/capture.js), but only
 * the top of the page can: a frame embedded in it stays marked as recording until the page changes.
 */
const noCapture = () => ({ page: { audio: false, video: false }, frames: { audio: false, video: false } })

/** True if a page might lose something by reloading: text typed in, your place in a video, or it asks before you leave. */
const WOULD_LOSE_SOMETHING = `(() => {
  const fields = document.querySelectorAll('textarea, input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button])')
  const startedMedia = [...document.querySelectorAll('video, audio')].some((m) => !m.paused || m.currentTime > 0)
  return startedMedia || Boolean(document.pictureInPictureElement) || Boolean(window.onbeforeunload) || Boolean(document.activeElement?.isContentEditable) || [...fields].some((f) => f.value !== f.defaultValue)
})()`

/**
 * True if replacing a page would throw away something you're in the middle of: a video you've started, or
 * text you've typed. A search box still holding your search doesn't count, nor do muted videos that play by themselves.
 */
const IN_USE = `(() => {
  const search = '[type=search],[role=combobox],[role=searchbox],[name=q],[name*=search i],form[role=search] input'
  const fields = document.querySelectorAll('textarea, input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=file])')
  const editing = document.activeElement?.isContentEditable && document.activeElement.textContent.trim()
  const watching = [...document.querySelectorAll('video, audio')].some((m) => m.currentTime > 0 && !m.ended && !m.muted)
  return watching || Boolean(document.pictureInPictureElement) || Boolean(editing) || [...fields].some((f) => f.value !== f.defaultValue && !f.matches(search))
})()`

/** Pops the biggest video on the page out into its own small window, or puts it back. */
const TOGGLE_PICTURE_IN_PICTURE = `(() => {
  if (document.pictureInPictureElement) return document.exitPictureInPicture().then(() => 'closed')
  const area = (v) => v.clientWidth * v.clientHeight
  const video = [...document.querySelectorAll('video')].filter((v) => v.readyState > 0).sort((a, b) => area(b) - area(a))[0]
  if (!video) return 'none'
  video.disablePictureInPicture = false
  return video.requestPictureInPicture().then(() => 'open')
})()`

class Tab {
  constructor(shell, { url, webContents, title, lazy = false, openerId = null, lastSeen, seenMs } = {}) {
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
    this.reportedLinksAcross = false
    this.capture = noCapture()
    this.sleeping = false
    this.lastSeen = Number.isFinite(lastSeen) ? lastSeen : Date.now()
    this.seenMs = Number.isFinite(seenMs) ? seenMs : 0 // how long it's been on screen, all told
    this.seenSince = null
    this.groupId = null

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
    this.sleeping = false
    this.applyBackground(url)
    // Load failures are reported through `did-fail-load`.
    this.webContents.loadURL(url).catch(() => {})
  }

  cameIntoView(now = Date.now()) {
    this.seenSince ??= now
    const refused = this.certificateWaiting
    this.certificateWaiting = null
    const wc = this.webContents
    // Only if it's still showing that device's error page.
    if (refused && !wc.isDestroyed() && wc.getURL() === refused.url && certificates.refusedFor(wc, refused.url)) {
      setImmediate(() => this.offerUntrustedCertificate(refused))
    }
  }

  wentOutOfView(now = Date.now()) {
    this.seenMs = this.totalSeenMs(now)
    this.seenSince = null
    this.lastSeen = now
  }

  totalSeenMs(now = Date.now()) {
    return this.seenMs + (this.seenSince == null ? 0 : now - this.seenSince)
  }

  /** Lazily restored tabs load once they're first shown; crashed background tabs recover the same way. */
  ensureLoaded() {
    if (this.pendingUrl) this.loadURL(this.pendingUrl)
    else if (this.sleeping) this.wake()
    else if (this.webContents.isCrashed()) this.recover()
  }

  /** Gives back the page's memory by ending its process. Its address and back/forward list stay. */
  async sleepIfUnused(now = Date.now(), unusedFor = require('./sleeping-tabs').SLEEP_AFTER_MS) {
    const wc = this.webContents
    if (this.sleeping || this.pendingUrl || wc.isDestroyed() || wc.isCrashed() || wc.isLoading()) return false
    if (now - this.lastSeen < unusedFor || this.shell.visibleTabs().includes(this)) return false
    if (!/^https?:/.test(this.url) || wc.isCurrentlyAudible() || wc.isDevToolsOpened()) return false
    if (this.usingCamera || this.usingMicrophone || this.hasNotifications()) return false
    // Ending a process ends everything in it, and a page may be sharing one with others.
    const pid = wc.getOSProcessId()
    if (allWebContents.getAllWebContents().some((other) => other !== wc && !other.isDestroyed() && other.getOSProcessId() === pid)) return false

    // Waking reloads, and reloading a page that came from a form would send the form again.
    if (blocker.cameFromForm(wc)) return false

    // A page that can't answer stays awake. An empty hidden frame, which can't either, has nothing to lose.
    const answers = Promise.all(wc.mainFrame.framesInSubtree.map((frame) => frame.executeJavaScript(WOULD_LOSE_SOMETHING).catch(() => !frame.parent)))
    const wouldLose = await Promise.race([
      answers.then((each) => each.some(Boolean)),
      new Promise((resolve) => setTimeout(resolve, 1500, true)), // not answering: leave it alone
    ])
    // That took a moment, and it may have been selected or started loading in the meantime.
    if (wouldLose || wc.isDestroyed() || wc.isLoading() || this.shell.visibleTabs().includes(this)) return false
    this.sleeping = true
    wc.forcefullyCrashRenderer()
    return true
  }

  wake() {
    this.sleeping = false
    this.webContents.reload()
    this.shell.tabChanged(this)
  }

  /** Sites you've let notify you have to stay running, or the notifications would stop. */
  hasNotifications() {
    try {
      return require('./store').get('permissions')?.[`${new URL(this.url).origin} notifications`] === true
    } catch {
      return false
    }
  }

  /** Where the page belongs. A page partway through a slide gets there when the slide ends. */
  place(rect) {
    this.rest = rect
    if (!this.stopSlide) this.view.setBounds(rect)
  }

  /** Starts `dx` away from where it belongs and slides there. */
  slideIn(dx, dy = 0) {
    const { enabled, tween, easeOut, SLIDE_MS } = require('./animations')
    this.stopSlide?.()
    this.stopSlide = null
    if (!enabled() || !this.rest || (!dx && !dy)) return
    const show = (progress) => {
      if (this.webContents.isDestroyed()) return
      this.view.setBounds({ ...this.rest, x: this.rest.x + Math.round(dx * (1 - progress)), y: this.rest.y + Math.round(dy * (1 - progress)) })
    }
    show(0)
    this.stopSlide = tween(SLIDE_MS, easeOut, show, () => (this.stopSlide = null))
  }

  /** Moves `dx` away from where it is, for a page on its way out of the window, then calls `done`. */
  slideOut(dx, dy, done) {
    const { enabled, tween, easeIn, SLIDE_MS } = require('./animations')
    this.stopSlide?.()
    this.stopSlide = null
    if (!enabled() || this.webContents.isDestroyed()) return done()
    const from = this.view.getBounds()
    const show = (progress) => {
      if (this.webContents.isDestroyed()) return
      this.view.setBounds({ ...from, x: from.x + Math.round(dx * progress), y: from.y + Math.round(dy * progress) })
    }
    this.stopSlide = tween(SLIDE_MS, easeIn, show, () => {
      this.stopSlide = null
      done()
    })
  }

  /** Links clicked on the left of a split open on the right. The right side's own links stay on the right. */
  sendsLinksAcross() {
    const store = require('./store')
    return store.get('splitLinks') !== false && this.split?.left === this.id && this.shell.visibleTabs().includes(this)
  }

  /** Tells the page whether its links should cross over, if that's changed or it's a new page. */
  reportLinksAcross({ newPage = false } = {}) {
    const wc = this.webContents
    if (wc.isDestroyed() || wc.isCrashed() || !wc.getURL()) return // no page to tell: it hears when it has one
    const on = this.sendsLinksAcross()
    if (on === this.reportedLinksAcross && !newPage) return
    this.reportedLinksAcross = on
    wc.send('split-links:state', on)
  }

  async inUse() {
    const wc = this.webContents
    if (this.pendingUrl || this.sleeping || wc.isDestroyed() || wc.isCrashed()) return false
    if (wc.isCurrentlyAudible() || this.usingCamera || this.usingMicrophone) return true
    const answers = Promise.all(wc.mainFrame.framesInSubtree.map((frame) => frame.executeJavaScript(IN_USE).catch(() => false)))
    return Promise.race([
      answers.then((each) => each.some(Boolean)),
      new Promise((resolve) => setTimeout(resolve, 400, true)), // not answering: leave it alone, and don't hold up the click
    ])
  }

  /** Whether the other side took the link. If not, it opens on this side, like a link anywhere else. */
  async openLinkAcross(url) {
    const partner = this.shell.partnerOf(this)
    if (!partner || !this.sendsLinksAcross() || !/^https?:/i.test(url) || (await partner.inUse())) return false
    const wc = partner.webContents
    if (wc.isDestroyed()) return false
    // A page can refuse to be left, silently, and then the click would seem to do nothing.
    return new Promise((resolve) => {
      const finish = (opened) => {
        clearTimeout(timer)
        wc.off('will-prevent-unload', refused)
        wc.off('did-start-navigation', started)
        resolve(opened)
      }
      const refused = () => finish(false)
      const started = (details) => details.isMainFrame && finish(true)
      const timer = setTimeout(finish, 2000, true)
      wc.on('will-prevent-unload', refused)
      wc.on('did-start-navigation', started)
      partner.loadURL(url)
      this.keepFocusFrom(partner)
    })
  }

  /**
   * A page gets the keyboard as it loads, but you're still on this side. Takes it back only from that page,
   * so it can't pull you out of the address bar, and only until you use that page yourself.
   */
  keepFocusFrom(partner) {
    const wc = partner.webContents
    const takeBack = () => {
      if (!wc.isDestroyed() && !this.webContents.isDestroyed() && wc.isFocused()) this.webContents.focus()
    }
    const youUsedIt = (_event, input) => {
      if (input.type === 'mouseDown' || input.type === 'keyDown' || input.type === 'rawKeyDown') stop()
    }
    const finished = () => {
      takeBack()
      stop()
    }
    const stop = () => {
      if (wc.isDestroyed()) return
      wc.off('focus', takeBack)
      wc.off('input-event', youUsedIt)
      wc.off('did-stop-loading', finished)
    }
    wc.on('focus', takeBack)
    wc.on('input-event', youUsedIt)
    wc.on('did-stop-loading', finished)
    takeBack()
  }

  async togglePictureInPicture() {
    const wc = this.webContents
    const frames = wc.isDestroyed() || wc.isCrashed() ? [] : wc.mainFrame.framesInSubtree
    for (const frame of frames) {
      const result = await frame.executeJavaScript(TOGGLE_PICTURE_IN_PICTURE, true).catch(() => 'none')
      if (result !== 'none') return result
    }
    this.shell.sendEvent('flash', 'There’s no video playing here')
    this.shell.peek()
    return 'none'
  }

  recover() {
    const { url } = this
    if (url) this.loadURL(url)
  }

  /** Offers a way out of a page that's stopped answering. The card goes away by itself if it recovers. */
  /** A device on your network refused for its own certificate: ask whether to continue to it anyway. */
  async offerUntrustedCertificate(refused) {
    const { shell } = this
    if (this.certificatePromptOpen) return
    // Off screen, it waits until you look at the tab (see cameIntoView).
    if (!shell.visibleTabs().includes(this)) {
      this.certificateWaiting = refused
      return
    }
    this.certificatePromptOpen = true
    await shell.uiLoaded // a window still starting up can't show cards yet
    let host = refused.url
    try {
      host = new URL(host).host || host
    } catch {}
    const { button } = await require('./prompts').ask(shell, {
      tag: `certificate-${this.id}`,
      title: 'Open this device anyway?',
      message: host,
      detail: 'It’s on your own network and uses a security certificate it made itself, which routers, printers and home servers often do. Only continue if you know this device. Glasswing will remember this certificate, and ask again if it ever changes.',
      buttons: [
        { id: 'back', label: 'Not now', style: 'secondary' },
        { id: 'open', label: 'Open anyway', style: 'danger' },
      ],
      cancelId: 'back',
    })
    this.certificatePromptOpen = false
    const wc = this.webContents
    if (button !== 'open' || wc.isDestroyed()) return
    certificates.trust(wc, refused)
    wc.loadURL(refused.url).catch(() => {}) // failures come back through did-fail-load
  }

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
      this.sleeping = false // reloaded some other way, as from the tab's menu
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
    wc.on('dom-ready', () => this.reportLinksAcross({ newPage: true }))
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
      const refused = certificates.refusedFor(wc, url)
      wc.executeJavaScript(errorPageScript(url, code, description, { certificate: Boolean(refused) })).catch(() => {})
      if (refused) this.offerUntrustedCertificate(refused)
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
      if (this.sleeping) return // on purpose: see sleepIfUnused
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

    wc.setWindowOpenHandler(({ disposition, url, features }) => {
      if (isInternal(url) && !isInternal(wc.getURL())) return { action: 'deny' }
      // Popups with window features (OAuth, payment flows) stay real windows so `window.opener` works.
      if (disposition === 'new-window' && features) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#ffffff' },
        }
      }
      // Everything else (target=_blank, middle-click, Shift+click, window.open without features) becomes a tab.
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
      crashed: alive && wc.isCrashed() && !this.sleeping,
      untrustedCertificate: alive && certificates.isOverridden(this.url, wc),
      sleeping: this.sleeping,
      blocked: blocker.countsFor(this.id),
      group: this.groupId,
      split: this.split ? (this.split.left === this.id ? 'left' : 'right') : null,
      splitPartner: this.split ? (this.split.left === this.id ? this.split.right : this.split.left) : null,
    }
  }

  destroy() {
    if (!this.webContents.isDestroyed()) this.webContents.close()
  }
}

module.exports = { Tab }
