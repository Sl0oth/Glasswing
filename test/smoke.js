// End-to-end smoke test: runs the real browser in a throwaway profile against a local test site, so
// it needs no network and never touches your own data. Safe to run while you're doing something
// else, even a game: its windows are never shown and it doesn't use the GPU, so it can't take focus
// or appear on screen. It never reads your screen or moves your mouse.
//
//   npm test
//   npm test -- --window-states        shows the window and tests maximize and full screen, which
//                                      DO take over the screen, so only use this when you're not busy
//   npm test -- --window-states --shots=some/folder    also saves pictures of each state
//
// Exits non-zero if a check fails, or if anything logs an error along the way.
const { app, BrowserWindow, clipboard, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')

const REPO = path.join(__dirname, '..')
const shotsDir = process.argv.find((a) => a.startsWith('--shots='))?.slice(8)
// Shows real windows. Keep the real mouse pointer off them: its events mix with the simulated tab drags.
const testWindowStates = process.argv.includes('--window-states')
process.env.GLASSWING_SKIP_BLOCKLIST_DOWNLOAD = '1' // this test brings its own filters

// Keep rendering normally without being on screen, and never grab focus.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
// Stand-ins, so the camera and mic tests never touch the real ones. Sound starts without a click.
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.disableHardwareAcceleration()
BrowserWindow.prototype.focus = () => {}
if (!testWindowStates) {
  BrowserWindow.prototype.show = () => {}
  BrowserWindow.prototype.showInactive = () => {}
  BrowserWindow.prototype.isVisible = () => true
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'glasswing-smoke-'))
app.setPath('userData', profile)
fs.writeFileSync(path.join(profile, 'glasswing.json'), JSON.stringify({ onboarded: true, appearance: { fullscreen: false } }))

// ── Reporting ────────────────────────────────────────────────────────────

const failures = []
const errors = []
let checks = 0

function check(name, ok, detail = '') {
  checks += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures.push(name)
}
const equal = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`)

process.on('uncaughtException', (err) => errors.push(`main: ${err.stack}`))
process.on('unhandledRejection', (err) => errors.push(`main (promise): ${err?.stack ?? err}`))

// ── Test site ────────────────────────────────────────────────────────────

const hits = []

const page = (title, color, body = '') =>
  `<!doctype html><title>${title}</title><body style="margin:0;background:${color};color:${color === '#fff' ? '#000' : '#fff'};font:16px system-ui">` +
  `<button id="top" style="position:fixed;left:0;top:0;width:100%;height:20px" onclick="window.topClicks=(window.topClicks||0)+1">top of page</button>` +
  `<h1 style="margin:60px 20px">${title}</h1>${body}`

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  const url = new URL(req.url, 'http://x')
  hits.push(url.pathname)
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.gif')) {
    res.setHeader('content-type', 'text/plain')
    return res.end('')
  }
  if (url.pathname === '/ads') {
    return res.end(page('Ads', '#fff', '<div class="ad-box" id="box">ad</div><div class="mine" id="mine">mine</div><script src="/banner-ad.js"></script><img src="/tracker-pixel.gif"><script src="/normal.js"></script>'))
  }
  if (url.pathname === '/media') return res.end(page('Media', '#fff', '<iframe id="inner" src="/media-frame" allow="camera;microphone"></iframe>'))
  if (url.pathname === '/dark') return res.end(page('Dark page', '#101014'))
  if (url.pathname === '/slow') return setTimeout(() => res.end(page('Slow page', '#fff')), 1200)
  if (url.pathname.startsWith('/login-')) {
    if (url.pathname === '/login-embed') return res.end(page('Embeds a login', '#fff', `<img src="${url.searchParams.get('src')}">`))
    if (req.headers.authorization === `Basic ${Buffer.from('me:secret').toString('base64')}`) return res.end(page('Signed in', '#fff'))
    res.statusCode = 401
    res.setHeader('www-authenticate', `Basic realm="Test ${url.pathname}"`)
    return res.end(page('Login needed', '#fff'))
  }
  if (url.pathname === '/links') {
    return res.end(page('Links', '#fff', '<a id="blank" target="_blank" href="/white">new tab</a> <a id="internal" href="glasswing://history/">internal</a>'))
  }
  res.end(page(`White page ${url.pathname}`, '#fff', '<p>needle needle needle</p>'))
})

// ── Helpers ──────────────────────────────────────────────────────────────

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(fn, ms = 4000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await fn()) return true
    await wait(50)
  }
  return false
}

/** Runs in the toolbar UI. */
const ui = (shell, code) => shell.ui.webContents.executeJavaScript(code, true)

/**
 * Saves a picture of the window by layering the browser's own views, the same way the window does:
 * a neutral stand-in for the desktop, then the backdrop, the page, and the floating UI on top.
 */
async function shot(shell, name) {
  if (!shotsDir || !testWindowStates) return // windows that are never shown have nothing to capture
  fs.mkdirSync(shotsDir, { recursive: true })
  const tab = shell.activeTab()
  const layers = [
    { wc: shell.win.webContents, bounds: { x: 0, y: 0 } },
    { wc: tab.webContents, bounds: tab.view.getBounds() },
    { wc: shell.ui.webContents, bounds: shell.ui.getBounds() },
  ]
  const [width, height] = shell.win.getContentSize()
  const output = Buffer.alloc(width * height * 4, 0x30)
  for (const { wc, bounds } of layers) {
    if (bounds.width === 0 || bounds.height === 0) continue
    const image = await wc.capturePage()
    if (image.isEmpty()) continue
    const size = image.getSize()
    const scaled = size.width === (bounds.width ?? width) ? image : image.resize({ width: bounds.width ?? width, height: bounds.height ?? height })
    const { width: w, height: h } = scaled.getSize()
    const source = scaled.toBitmap() // premultiplied BGRA
    for (let y = 0; y < h && y + bounds.y < height; y++) {
      for (let x = 0; x < w && x + bounds.x < width; x++) {
        const from = (y * w + x) * 4
        const to = ((y + bounds.y) * width + x + bounds.x) * 4
        const keep = 255 - source[from + 3]
        for (let c = 0; c < 3; c++) output[to + c] = Math.min(255, source[from + c] + Math.round((output[to + c] * keep) / 255))
        output[to + 3] = 255
      }
    }
  }
  const png = nativeImage.createFromBitmap(output, { width, height }).toPNG()
  fs.writeFileSync(path.resolve(shotsDir, `${name}.png`), png)
}

// ── The tests ────────────────────────────────────────────────────────────

async function run() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const { BrowserShell } = require(path.join(REPO, 'src/main/shell.js'))
  const favorites = require(path.join(REPO, 'src/main/favorites.js'))
  const menus = require(path.join(REPO, 'src/main/menus.js'))
  const appearance = require(path.join(REPO, 'src/main/appearance.js'))

  await until(() => BrowserShell.all.size > 0, 15000)
  const shell = [...BrowserShell.all][0]
  const { win } = shell
  await until(() => win.isVisible(), 5000)
  win.setBounds({ x: 40, y: 40, width: 1280, height: 800 })

  shell.ui.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(`ui console: ${details.message} (${details.sourceId}:${details.lineNumber})`)
  })
  // Stops the pointer's real position from affecting the auto-hide checks.
  const electron = require('electron')
  const realCursor = electron.screen.getCursorScreenPoint
  let cursor = null
  electron.screen.getCursorScreenPoint = () => cursor ?? realCursor.call(electron.screen)
  const moveCursor = (x, y) => {
    const b = win.getContentBounds()
    cursor = { x: b.x + x, y: b.y + y }
  }
  moveCursor(640, 500)

  const uiHeight = () => shell.ui.getBounds().height
  const load = async (tab, url) => {
    const done = new Promise((resolve) => tab.webContents.once('did-stop-loading', resolve))
    tab.loadURL(url)
    await done
    await wait(100)
  }

  console.log('\nNew tab page')
  await wait(1200)
  check('toolbar is showing on the new tab page', shell.revealed === true)
  check('address bar has focus', await ui(shell, `document.activeElement.id === 'address-input'`))
  equal('favorites bar is left out (the page shows them)', await ui(shell, `document.body.classList.contains('favbar-open')`), false)
  const newtab = shell.activeTab()
  check('new tab page lists favorites', await until(() => newtab.webContents.executeJavaScript(`document.querySelectorAll('.fav:not(.add)').length === 6`)))
  await shot(shell, '1-newtab')

  console.log('\nFloating toolbar over a page')
  const tab = shell.activeTab()
  await load(tab, `${base}/white`)
  check('page fills the whole window', (() => {
    const b = tab.view.getBounds()
    const [w, h] = win.getContentSize()
    return b.x === 0 && b.y === 0 && b.width === w && b.height === h
  })())
  await ui(shell, `document.activeElement.blur()`)
  check('toolbar slides away by itself', await until(() => !shell.revealed))
  check('then nothing covers the page at all', await until(() => uiHeight() === 0, 1500), `height ${uiHeight()}`)
  await shot(shell, '2-hidden-white')

  moveCursor(640, 1)
  check('touching the top edge brings the toolbar down', await until(() => shell.revealed, 1000))
  check('favorites bar comes with it', await until(() => ui(shell, `document.body.classList.contains('favbar-open') && document.querySelectorAll('.fav-item').length === 6`)))
  await wait(450)
  const layout = await ui(shell, `(() => {
    const chrome = getComputedStyle(document.getElementById('chrome')).backgroundColor
    const toolbar = getComputedStyle(document.getElementById('toolbar')).backgroundColor
    const r = (s) => document.querySelector(s).getBoundingClientRect()
    return { chrome, toolbar, left: r('#left-pill').y, fav: r('#fav-pill').y, tab: r('.tab.active').y, height: document.getElementById('toolbar').offsetHeight, favbar: document.getElementById('favbar').offsetHeight, findbar: getComputedStyle(document.getElementById('findbar')).height }
  })()`)
  equal('the bar behind the elements has no background', [layout.chrome, layout.toolbar], ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
  check('elements have slid fully into view', layout.left > 0 && layout.tab > 0 && layout.fav > layout.left, JSON.stringify(layout))
  equal('CSS heights match the main process', [layout.height, layout.favbar, layout.findbar], [48, 36, '42px'])
  await shot(shell, '3-revealed-white')

  moveCursor(640, 22) // over the active tab
  await wait(900)
  // Pages aren't resized in a window that's never shown, so these two need a visible one.
  if (testWindowStates) check('stays down while the pointer is on an element', shell.revealed === true)
  moveCursor(60, 500)
  check('slides away when the pointer leaves', await until(() => !shell.revealed, 1500))
  moveCursor(640, 500)

  const empty = await ui(shell, `(() => {
    const a = document.getElementById('left-pill').getBoundingClientRect()
    return { x: Math.round(a.right + 1), y: 20 }
  })()`)
  moveCursor(640, 1)
  await until(() => shell.revealed, 1000)
  await wait(450)
  moveCursor(empty.x, empty.y + 60) // beside the favorites, below the toolbar row: empty space
  check('empty space between elements does not hold the toolbar', await until(() => !shell.revealed, 1500))
  moveCursor(640, 500)

  console.log('\nFavorites')
  favorites.add({ title: 'Test Dark', url: `${base}/dark` })
  await wait(100)
  check('bar updates when a favorite is added', await until(() => ui(shell, `document.querySelectorAll('.fav-item').length === 7`)))
  shell.peek()
  await wait(100)
  await ui(shell, `document.querySelectorAll('.fav-item')[6].dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, clientX: 5, clientY: 5 })); window.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 5, clientY: 5 }))`)
  check('clicking a favorite opens it', await until(() => tab.url === `${base}/dark`))
  await wait(300)
  shell.peek()
  await wait(450)
  await shot(shell, '4-revealed-dark')

  check('star shows this page is a favorite', await until(() => ui(shell, `document.getElementById('star').classList.contains('on')`)))
  menus.toggleFavorite(shell)
  check('Ctrl+D action removes it again', !favorites.has(`${base}/dark`))
  check('star turns off', await until(() => ui(shell, `!document.getElementById('star').classList.contains('on')`)))
  menus.toggleFavorite(shell)
  check('Ctrl+D action adds it back', favorites.has(`${base}/dark`))
  equal('dropped in at the end', favorites.list().at(-1).url, `${base}/dark`)

  favorites.move(`${base}/dark`, 0)
  equal('reordering works', favorites.list()[0].url, `${base}/dark`)
  check('bar follows the new order', await until(() => ui(shell, `document.querySelector('.fav-item .fav-title').textContent === 'Dark page' || document.querySelector('.fav-item .fav-title').textContent === 'Test Dark'`)))

  favorites.add({ title: 'Bad', url: 'javascript:alert(1)' })
  check('rejects a non-web address', !favorites.list().some((f) => f.title === 'Bad'))
  favorites.add({ title: 'Duplicate', url: `${base}/dark` })
  equal('rejects duplicates', favorites.list().filter((f) => f.url === `${base}/dark`).length, 1)
  check('update refuses a non-web address', favorites.update(`${base}/dark`, { title: 'x', url: 'mailto:a@b.c' }) === false)

  const many = [...favorites.list()]
  for (let i = 0; i < 30; i++) many.push({ title: `Favorite number ${i}`, url: `https://example${i}.test/` })
  favorites.replace(many)
  shell.peek()
  await wait(500)
  const fit = await ui(shell, `(() => {
    const pill = document.getElementById('fav-pill').getBoundingClientRect()
    return { right: pill.right, width: innerWidth, more: !document.getElementById('fav-more').hidden, overflowFrom: favOverflowFrom, visible: [...document.querySelectorAll('.fav-item')].filter((el) => !el.hidden).length }
  })()`)
  check('too many favorites go behind the » button', fit.more && fit.right <= fit.width && fit.visible === fit.overflowFrom && fit.visible < many.length, JSON.stringify(fit))
  await shot(shell, '5-favorites-overflow')
  favorites.replace(many.slice(0, 7))
  await wait(100)

  // Edit a favorite through the real prompt card.
  const target = favorites.list()[1]
  menus.favoriteContextMenu(shell, target.url, 300, 90)
  check('favorite right-click menu opens', await until(() => ui(shell, `document.querySelectorAll('.menu-item').length === 5`)))
  await ui(shell, `[...document.querySelectorAll('.menu-item')].find((r) => r.textContent.includes('Edit')).click()`)
  check('edit card opens with its fields', await until(() => ui(shell, `document.querySelectorAll('.prompt-field input').length === 2`)))
  await shot(shell, '6-edit-favorite')
  await ui(shell, `(() => { const [n] = document.querySelectorAll('.prompt-field input'); n.value = 'Renamed'; n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
  check('saving renames it', await until(() => favorites.list()[1].title === 'Renamed'))
  check('card closes and the window shrinks back', await until(() => ui(shell, `!document.body.classList.contains('expanded')`)))

  console.log('\nAddress bar')
  shell.focusAddressBar()
  check('Ctrl+L brings the toolbar down', await until(() => shell.revealed))
  check('and holds it there while editing', await until(() => shell.uiHold === true))
  await wait(800)
  check('still down after the pointer has been away', shell.revealed === true)
  await ui(shell, `(() => { const i = document.getElementById('address-input'); i.value = 'Renamed'; i.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' })) })()`)
  check('favorites appear in suggestions', await until(() => ui(shell, `[...document.querySelectorAll('#suggestions .section-label')].some((s) => s.textContent === 'Favorites')`)))
  await shot(shell, '7-suggestions')
  const panel = await ui(shell, `(() => { const r = document.getElementById('suggestions').getBoundingClientRect(); return { top: r.top, bottom: r.bottom } })()`)
  check('suggestions sit on screen, under the toolbar', panel.top >= 40 && panel.bottom > panel.top, JSON.stringify(panel))

  // Right-click paste keeps the field in use.
  await clipboard.writeText('pasted.example')
  await ui(shell, `(() => { const i = document.getElementById('address-input'); i.value=''; i.focus(); i.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 25 })) })()`)
  check('address bar has a right-click menu', await until(() => ui(shell, `[...document.querySelectorAll('.menu-item')].some((r) => r.textContent.includes('Paste and Go'))`)))
  await wait(200)
  const menuRect = await ui(shell, `(() => { const r = document.querySelector('.menu').getBoundingClientRect(); return { top: r.top, height: r.height, inner: innerHeight } })()`)
  if (testWindowStates) check('menu is placed where it was asked for', menuRect.top >= 20 && menuRect.top + menuRect.height <= menuRect.inner, JSON.stringify(menuRect))
  await ui(shell, `[...document.querySelectorAll('.menu-item')].find((r) => r.textContent.includes('Paste') && !r.textContent.includes('Go')).click()`)
  check('paste lands in the field', await until(() => ui(shell, `document.getElementById('address-input').value === 'pasted.example'`)))
  await ui(shell, `document.getElementById('address-input').blur()`)
  check('hold is released when editing ends', await until(() => shell.uiHold === false))
  check('toolbar leaves afterwards', await until(() => !shell.revealed, 2500))

  console.log('\nDropdowns while the toolbar is out of sight')
  await until(() => uiHeight() === 0, 1000)
  shell.sendEvent('toggle-downloads')
  check('Ctrl+J grows the view', await until(() => uiHeight() === win.getContentSize()[1]))
  await wait(200)
  const dl = await ui(shell, `(() => { const r = document.getElementById('downloads-panel').getBoundingClientRect(); return { top: r.top, right: r.right, width: innerWidth } })()`)
  check('downloads panel opens at the top right, on screen', dl.top >= 40 && dl.right > dl.width - 100 && dl.right <= dl.width, JSON.stringify(dl))
  shell.sendEvent('toggle-downloads')
  check('and shrinks back', await until(() => uiHeight() === 0, 1500))

  console.log('\nLoading while the toolbar is out of sight')
  tab.loadURL(`${base}/slow`)
  check('a thin line shows the page is loading', await until(() => uiHeight() === 3, 1000), `height ${uiHeight()}`)
  check('and it is drawn', await until(() => ui(shell, `getComputedStyle(document.getElementById('top-progress')).display === 'block'`), 1000))
  check('then it goes away, leaving nothing over the page', await until(() => !tab.webContents.isLoading() && uiHeight() === 0, 4000), `height ${uiHeight()}`)

  console.log('\nFind')
  shell.openFind()
  check('find opens the toolbar', await until(() => shell.revealed && uiHeight() >= 48 + 36 + 42))
  await until(() => ui(shell, `document.activeElement.id === 'find-input'`))
  await ui(shell, `(() => { const i = document.getElementById('find-input'); i.value = 'Slow'; i.dispatchEvent(new Event('input')) })()`)
  check('find counts matches', await until(() => ui(shell, `/of/.test(document.getElementById('find-count').textContent)`)))
  await wait(300)
  await shot(shell, '8-find')
  await wait(800)
  check('stays open when the pointer is away', shell.revealed && shell.findOpen)
  shell.closeFind()
  check('closing releases the toolbar', await until(() => !shell.revealed, 2500))

  console.log('\nTabs')
  const second = shell.createTab({ url: `${base}/two` })
  await until(() => !second.webContents.isLoading())
  equal('new tab becomes active', shell.activeId, second.id)
  shell.selectRelative(-1)
  equal('switching back works', shell.activeId, tab.id)
  check('switching tabs peeks the toolbar', shell.revealed === true)
  shell.selectTab(second.id)
  await second.webContents.executeJavaScript(`document.title = 'Renamed tab'`)
  const reopenCount = shell.order.length
  shell.closeTab(second.id)
  equal('closing a tab removes it', shell.order.length, reopenCount - 1)
  shell.reopenClosedTab()
  equal('reopen closed tab brings it back', shell.order.length, reopenCount)
  await wait(300)
  shell.closeTab(shell.activeId)

  // Pages can close themselves. This used to throw in the main process.
  const closes = shell.createTab({ url: `${base}/closes` })
  await until(() => !closes.webContents.isLoading())
  const closeId = closes.id
  await closes.webContents.executeJavaScript('window.close()', true).catch(() => {})
  check('a page calling window.close() closes its tab cleanly', await until(() => !shell.tabs.has(closeId)))
  check('another tab takes over', shell.activeId != null && shell.tabs.has(shell.activeId))
  shell.getState()

  // Links.
  shell.selectTab(tab.id)
  await load(tab, `${base}/links`)
  const count = shell.order.length
  const opened = new Promise((resolve) => {
    const before = new Set(shell.order)
    const timer = setInterval(() => {
      const id = shell.order.find((x) => !before.has(x))
      if (id) {
        clearInterval(timer)
        resolve(id)
      }
    }, 30)
  })
  await tab.webContents.executeJavaScript(`document.getElementById('blank').click()`, true)
  const newId = await Promise.race([opened, wait(3000)])
  check('target=_blank opens a new tab', newId != null && shell.order.length === count + 1)
  if (newId != null) {
    await until(() => shell.tabs.get(newId).url.endsWith('/white'))
    equal('opened right after its opener', shell.order.indexOf(newId), shell.order.indexOf(tab.id) + 1)
    shell.closeTab(newId)
  }
  shell.selectTab(tab.id)
  await tab.webContents.executeJavaScript(`document.getElementById('internal').click()`, true)
  await wait(500)
  check('websites cannot navigate to the browser\'s own pages', !tab.url.startsWith('glasswing:'), tab.url)

  console.log('\nError and crash recovery')
  const bad = shell.createTab({ url: 'http://127.0.0.1:9/' })
  await until(() => !bad.webContents.isLoading(), 6000)
  await wait(300)
  check('unreachable site shows the error page', (await bad.webContents.executeJavaScript('document.body.innerText').catch(() => '')).includes('Can’t open this page'))
  shell.closeTab(bad.id)

  const crash = shell.createTab({ url: `${base}/crash` })
  await until(() => !crash.webContents.isLoading())
  await wait(200)
  crash.webContents.forcefullyCrashRenderer()
  check('crash shows a recovery card', await until(() => ui(shell, `[...document.querySelectorAll('.prompt-title')].some((t) => t.textContent === 'This page stopped working')`)))
  await wait(250)
  await shot(shell, '9-crash')
  await ui(shell, `[...document.querySelectorAll('.prompt .btn')].find((b) => b.textContent === 'Reload').click()`)
  check('reload brings the page back', await until(() => !crash.webContents.isCrashed() && crash.state().title.includes('/crash'), 5000))
  shell.closeTab(crash.id)

  // A different site, so it gets its own process: same-site tabs can share one, and crash together.
  const crashBg = shell.createTab({ url: `${base.replace('127.0.0.1', 'localhost')}/crash-bg`, active: false })
  equal('a background tab stays in the background', shell.activeId !== crashBg.id, true)
  await until(() => !crashBg.webContents.isLoading())
  const gone = new Promise((resolve) => crashBg.webContents.once('render-process-gone', resolve))
  crashBg.webContents.forcefullyCrashRenderer()
  await gone
  const cards = await ui(shell, `[...document.querySelectorAll('.prompt:not(.leaving)')].map((c) => c.textContent)`)
  check('no card for a tab that is not on screen', cards.length === 0, `${JSON.stringify(cards)} pids ${crashBg.webContents.getOSProcessId()} active ${shell.activeTab().webContents.getOSProcessId()}`)
  shell.selectTab(crashBg.id)
  check('crashed background tab recovers when selected', await until(() => !crashBg.webContents.isCrashed(), 5000))
  shell.closeTab(crashBg.id)

  const activeBefore = shell.activeId
  const lazy = shell.createTab({ url: `${base}/lazy`, title: 'Lazy', lazy: true, active: false })
  await wait(400)
  equal('restored tabs wait to load until selected', [lazy.webContents.getURL(), shell.activeId], ['', activeBefore])
  shell.selectTab(lazy.id)
  check('and load once they are', await until(() => lazy.webContents.getURL().endsWith('/lazy')))
  shell.closeTab(lazy.id)

  console.log('\nSplit view')
  shell.selectTab(tab.id)
  await load(tab, `${base}/white`)
  const paneB = shell.createTab({ url: `${base}/pane-b`, active: false })
  await until(() => paneB.webContents.getURL().endsWith('/pane-b'))
  equal('dragging a tab does not select it by itself', shell.activeId, tab.id)
  shell.splitWith(paneB.id, tab.id, 'right')
  const [cw, ch] = win.getContentSize()
  const rects = () => [tab.view.getBounds(), paneB.view.getBounds()]
  let [leftRect, rightRect] = rects()
  check('both pages are on screen, side by side', leftRect.width > 400 && rightRect.width > 400 && leftRect.x + leftRect.width < rightRect.x, JSON.stringify(rects()))
  check('they use the full height', leftRect.height > ch - 20 && rightRect.height === leftRect.height)
  check('and fit inside the window', rightRect.x + rightRect.width <= cw)
  equal('the dragged tab has focus', shell.activeId, paneB.id)
  equal('they sit together in the tab strip', shell.order.indexOf(paneB.id), shell.order.indexOf(tab.id) + 1)
  check('tab strip shows they are joined', await until(() => ui(shell, `document.querySelector('.tab.split-left') && document.querySelector('.tab.split-right') && document.querySelector('.tab.split-visible') !== null`)))
  shell.peek()
  await wait(450)
  await shot(shell, '12-split')

  shell.paneFocused(tab)
  equal('clicking the other side moves the toolbar to it', shell.activeId, tab.id)
  shell.dragSplitDivider(shell.splitArea.x + shell.splitArea.width * 0.7)
  ;[leftRect, rightRect] = rects()
  check('dragging the divider resizes both', leftRect.width > rightRect.width * 2, JSON.stringify(rects()))
  shell.dragSplitDivider(5)
  check('and can\'t squash a side away', tab.view.getBounds().width > 150)
  shell.resetSplitDivider()
  await win.webContents.executeJavaScript(`window.backdrop.divider('drag', ${shell.splitArea.x + shell.splitArea.width * 0.3})`)
  check('the divider on the page reaches the browser', await until(() => tab.view.getBounds().width < paneB.view.getBounds().width, 1000))
  check('the page behind draws it', await win.webContents.executeJavaScript(`document.body.classList.contains('split') && getComputedStyle(document.getElementById('divider')).display === 'block'`))
  await win.webContents.executeJavaScript(`window.backdrop.divider('reset')`)
  check('double-click evens it out', await until(() => Math.abs(tab.view.getBounds().width - paneB.view.getBounds().width) <= 1, 1000))
  menus.tabContextMenu(shell, tab.id, 300, 30)
  check('tab menu offers to separate', await until(() => ui(shell, `[...document.querySelectorAll('.menu-item')].some((r) => r.textContent.includes('Separate Split View'))`), 1500))
  await ui(shell, `closeMenus()`)
  await until(() => ui(shell, `!document.body.classList.contains('expanded')`), 1000)
  const before3 = tab.view.getBounds().x
  shell.swapSplit()
  check('swap sides trades places', tab.view.getBounds().x > before3)
  equal('and the strip follows', shell.order.indexOf(tab.id), shell.order.indexOf(paneB.id) + 1)
  shell.swapSplit()

  const other = shell.createTab({ url: `${base}/other` })
  await until(() => !other.webContents.isLoading())
  equal('another tab shows on its own', [shell.visibleTabs().length, other.view.getBounds().width], [1, cw])
  check('the pair is out of the window meanwhile', !shell.shownTabs.includes(tab) && !shell.shownTabs.includes(paneB))
  shell.selectTab(tab.id)
  equal('going back shows both again', shell.visibleTabs().length, 2)

  const saved = shell.serialize()
  equal('split view is remembered', saved.splits.length, 1)
  equal('as the right tabs', [saved.tabs[saved.splits[0].left].url, saved.tabs[saved.splits[0].right].url], [tab.url, paneB.url])
  shell.moveTab(other.id, shell.order.indexOf(tab.id) + 1)
  equal('a tab can\'t land between the two sides', shell.order.indexOf(paneB.id), shell.order.indexOf(tab.id) + 1)
  shell.splitWith(other.id, tab.id, 'right')
  check('splitting with a third tab replaces the old partner', paneB.split === null && tab.split?.right === other.id)
  shell.selectTab(paneB.id)
  equal('and the old partner goes back to being single', shell.visibleTabs().length, 1)
  shell.selectTab(other.id)
  shell.unsplit()
  equal('separate goes back to one page', [shell.visibleTabs().length, other.view.getBounds().width], [1, cw])
  shell.closeTab(other.id)
  shell.selectTab(tab.id)

  shell.toggleSplit()
  equal('Ctrl+\\ pairs with the most recent tab', shell.visibleTabs().length, 2)
  shell.closeTab(paneB.id)
  equal('closing one side leaves the other, full size', [shell.activeId, tab.view.getBounds().width], [tab.id, cw])
  check('with no split left behind', tab.split === null)

  const restored = BrowserShell.create({
    tabs: [{ url: `${base}/r-left` }, { url: `${base}/r-right` }, { url: `${base}/r-lazy` }],
    activeIndex: 1,
    splits: [{ left: 0, right: 1, ratio: 0.3 }, { left: 2, right: 2 }, { left: 9, right: 1 }, null],
    fullscreen: false,
  })
  const [rLeft, rRight, rLazy] = restored.order.map((id) => restored.tabs.get(id))
  equal('a split comes back after a restart', [restored.visibleTabs().length, rLeft.split?.ratio, restored.activeId], [2, 0.3, rRight.id])
  check('both sides load', await until(() => rLeft.webContents.getURL().endsWith('/r-left') && rRight.webContents.getURL().endsWith('/r-right')))
  equal('other restored tabs still wait', rLazy.webContents.getURL(), '')
  restored.win.close()
  await until(() => !BrowserShell.all.has(restored))

  const only = BrowserShell.create({ urls: [`${base}/only`], fullscreen: false })
  await until(() => only.activeTab() && !only.activeTab().webContents.isLoading())
  only.toggleSplit()
  equal('split view with one tab opens a new one beside it', [only.order.length, only.visibleTabs().length], [2, 2])
  only.win.close()
  await until(() => !BrowserShell.all.has(only))

  console.log('\nDragging a tab out')
  shell.selectTab(tab.id)
  const dragged = shell.createTab({ url: `${base}/dragged`, active: false })
  await until(() => dragged.webContents.getURL().endsWith('/dragged'))
  await ui(shell, `document.activeElement.blur()`)
  shell.peek()
  await wait(400)
  const b = win.getContentBounds()
  const tabPoint = async (id) => ui(shell, `(() => { const r = document.querySelector('.tab[data-id="${id}"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
  const mouse = (type, x, y, buttons = 1) => `window.dispatchEvent(new MouseEvent('${type}', { bubbles: true, button: 0, buttons: ${buttons}, clientX: ${x}, clientY: ${y} }))`
  const press = (id, x, y) => ui(shell, `document.querySelector('.tab[data-id="${id}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, clientX: ${x}, clientY: ${y} }))`)

  // A plain click still selects.
  let point = await tabPoint(dragged.id)
  await press(dragged.id, point.x, point.y)
  equal('pressing a tab leaves the current one showing', shell.activeId, tab.id)
  await ui(shell, mouse('mouseup', point.x, point.y, 0))
  check('releasing it selects it', await until(() => shell.activeId === dragged.id, 1000))
  shell.selectTab(tab.id)
  await wait(200)

  // Pull it down over the page and pick a zone.
  const pull = async (x, y) => {
    moveCursor(x, y)
    await ui(shell, mouse('mousemove', x, y))
  }
  point = await tabPoint(dragged.id)
  await press(dragged.id, point.x, point.y)
  await pull(point.x + 2, 200)
  check('pulling a tab down offers the zones', await until(() => ui(shell, `!document.getElementById('drag-zones').hidden`), 1500))
  check('over the whole page', await until(() => uiHeight() === win.getContentSize()[1], 1000))
  equal('the page you\'re on stays on screen', shell.activeId, tab.id)
  check('a label follows the pointer', BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().endsWith('ghost.html')) || await until(() => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().endsWith('ghost.html')), 500))
  await pull(100, 300)
  check('left third highlights Split left', await until(() => ui(shell, `document.querySelector('.drag-zone.over')?.dataset.zone === 'left'`), 1000))
  await shot(shell, '13-drag-zones')
  await pull(640, 300)
  check('middle highlights New window', await until(() => ui(shell, `document.querySelector('.drag-zone.over')?.dataset.zone === 'center'`), 1000))
  await pull(1200, 300)
  check('right third highlights Split right', await until(() => ui(shell, `document.querySelector('.drag-zone.over')?.dataset.zone === 'right'`), 1000))

  // Back into the strip: just a reorder again.
  await pull(point.x, point.y)
  check('back in the strip the zones go away', await until(() => ui(shell, `document.getElementById('drag-zones').hidden`), 1000))
  await pull(1200, 300)
  await until(() => ui(shell, `!document.getElementById('drag-zones').hidden`), 1000)

  // Escape cancels.
  await ui(shell, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  check('Escape cancels the drag', await until(() => ui(shell, `document.getElementById('drag-zones').hidden && dragState === null`), 1000))
  equal('nothing changed', [shell.visibleTabs().length, shell.tabs.has(dragged.id)], [1, true])
  check('no label left behind', await until(() => !BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents.getURL().endsWith('ghost.html')), 1000))

  // Drop on the right third: split view.
  point = await tabPoint(dragged.id)
  await press(dragged.id, point.x, point.y)
  await pull(1200, 300)
  await until(() => ui(shell, `document.querySelector('.drag-zone.over')?.dataset.zone === 'right'`), 1000)
  await ui(shell, mouse('mouseup', 1200, 300, 0))
  check('dropping on a side makes a split view', await until(() => shell.visibleTabs().length === 2 && dragged.split?.right === dragged.id, 1500))
  equal('with what you were looking at on the other side', dragged.split?.left, tab.id)
  shell.unsplit()
  shell.selectTab(tab.id)
  await wait(200)

  // Drop in the middle: new window, same page.
  await dragged.webContents.executeJavaScript('window.keepMe = 42')
  const windowCount = BrowserShell.all.size
  point = await tabPoint(dragged.id)
  await press(dragged.id, point.x, point.y)
  await pull(640, 300)
  await until(() => ui(shell, `document.querySelector('.drag-zone.over')?.dataset.zone === 'center'`), 1000)
  await ui(shell, mouse('mouseup', 640, 300, 0))
  check('dropping in the middle makes a new window', await until(() => BrowserShell.all.size === windowCount + 1, 2000))
  const torn = dragged.shell
  check('the tab is in it', torn !== shell && torn.tabs.has(dragged.id) && !shell.tabs.has(dragged.id))
  equal('the page came along without reloading', await dragged.webContents.executeJavaScript('window.keepMe'), 42)
  equal('and is showing', torn.activeId, dragged.id)
  check('the new window is a normal one', !torn.win.isFullScreen())
  check('the old window moved on to another tab', shell.tabs.has(shell.activeId))
  await until(() => torn.ui.webContents.getURL().endsWith('index.html'))
  await wait(500)
  check('its page is laid out', dragged.view.getBounds().width > 0)
  check('the old window no longer shows it', !shell.shownTabs.includes(dragged))
  dragged.zoom(0)
  check('tab events now go to the new window', torn.getState().tabs[0].id === dragged.id)

  // Back again: over the first window, from the torn-off one.
  torn.win.setBounds({ x: b.x + 2000, y: b.y, width: 800, height: 600 })
  await wait(100)
  await until(() => torn.ui.webContents.executeJavaScript('document.readyState === "complete"'))
  const tornUi = (code) => torn.ui.webContents.executeJavaScript(code, true)
  await until(() => tornUi(`document.querySelector('.tab[data-id="${dragged.id}"]') !== null`))
  torn.peek()
  await wait(300)
  await tornUi(`document.querySelector('.tab[data-id="${dragged.id}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, clientX: 400, clientY: 24 }))`)
  moveCursor(300, 400) // over the first window, in its coordinates
  await tornUi(mouse('mousemove', -2000, 400))
  check('holding it over another window shows where it would land', await until(() => ui(shell, `!document.getElementById('drop-marker').hidden`), 1500))
  check('that window brings its toolbar down', await until(() => shell.revealed, 1000))
  await shot(shell, '14-drop-target')
  await tornUi(mouse('mouseup', -2000, 400, 0))
  check('dropping moves the tab back', await until(() => dragged.shell === shell && shell.tabs.has(dragged.id), 1500))
  equal('it\'s still the same page', await dragged.webContents.executeJavaScript('window.keepMe'), 42)
  equal('and it\'s showing', shell.activeId, dragged.id)
  check('the emptied window closes', await until(() => !BrowserShell.all.has(torn), 2000))
  check('the marker goes away', await until(() => ui(shell, `document.getElementById('drop-marker').hidden`), 1000))
  moveCursor(640, 500)
  shell.closeTab(dragged.id)
  shell.selectTab(tab.id)

  // Menu version.
  const viaMenu = shell.createTab({ url: `${base}/menu`, active: false })
  await until(() => viaMenu.webContents.getURL().endsWith('/menu'))
  const newShell = shell.moveToNewWindow(viaMenu)
  check('Move to New Window works', newShell && newShell.tabs.has(viaMenu.id))
  newShell.win.close()
  await until(() => !BrowserShell.all.has(newShell))
  check('closing that window closes the tab', viaMenu.webContents.isDestroyed())
  check('a window with one tab can\'t tear off into nothing', (() => {
    const before4 = BrowserShell.all.size
    const single = [...BrowserShell.all].find((x) => x.order.length === 1)
    if (!single) return true
    single.moveToNewWindow(single.activeTab())
    return BrowserShell.all.size === before4
  })())

  console.log('\nAd and tracker blocking')
  const blocker = require(path.join(REPO, 'src/main/blocker.js'))
  blocker.useFilters({ ads: '/banner-ad.js$script\n##.ad-box', trackers: '/tracker-pixel.gif$image' })
  const adsUrl = `${base}/ads`
  const visit = async () => {
    hits.length = 0
    await load(tab, adsUrl)
    await wait(350)
    return { ad: hits.includes('/banner-ad.js'), tracker: hits.includes('/tracker-pixel.gif'), normal: hits.includes('/normal.js') }
  }
  shell.selectTab(tab.id)
  equal('on by default', [blocker.getSettings().ads, blocker.getSettings().trackers], [true, true])
  equal('ads and trackers are blocked, the rest loads', await visit(), { ad: false, tracker: false, normal: true })
  equal('and counted separately', tab.state().blocked, { ads: 1, trackers: 1 })
  check('the page\'s leftover ad box is hidden', await until(() => tab.webContents.executeJavaScript(`getComputedStyle(document.getElementById('box')).display === 'none'`), 2000))
  check('the shield shows the count', await until(() => ui(shell, `document.getElementById('shield-count').textContent === '2' && !document.getElementById('shield-count').hidden`), 1500))
  equal('a new page starts the count over', (await visit(), tab.state().blocked), { ads: 1, trackers: 1 })
  const listeners = tab.webContents.listenerCount('destroyed')
  for (let i = 0; i < 5; i++) await visit()
  equal('page after page, nothing piles up', tab.webContents.listenerCount('destroyed'), listeners)

  blocker.set({ trackers: false })
  equal('trackers off: only ads are blocked', await visit(), { ad: false, tracker: true, normal: true })
  equal('and the count agrees', tab.state().blocked, { ads: 1, trackers: 0 })
  blocker.set({ ads: false, trackers: true })
  equal('ads off: only trackers are blocked', await visit(), { ad: true, tracker: false, normal: true })
  equal('and the count agrees too', tab.state().blocked, { ads: 0, trackers: 1 })
  blocker.set({ ads: true, trackers: true })

  blocker.toggleSite(adsUrl)
  equal('a site can be let through', await visit(), { ad: true, tracker: true, normal: true })
  check('the ad box stays too', await tab.webContents.executeJavaScript(`getComputedStyle(document.getElementById('box')).display !== 'none'`))
  check('with the shield showing it\'s off', await until(() => ui(shell, `document.getElementById('shield-btn').classList.contains('off')`), 1500))
  blocker.toggleSite(adsUrl)
  equal('and blocked again', await visit(), { ad: false, tracker: false, normal: true })

  for (const [url, safe] of [['https://accounts.google.com/x', true], ['https://js.stripe.com/v3/', true], ['https://challenges.cloudflare.com/turnstile', true], ['https://stripe.com.evil.test/', false], ['https://example.com/', false]]) {
    equal(`safeguard ${safe ? 'covers' : 'skips'} ${new URL(url).host}`, blocker.isSafeguarded(url), safe)
  }

  blocker.setCustomRules('/normal.js$script\n@@/banner-ad.js$script\n##.mine\nnot a [valid rule')
  equal('your own rules block, and make exceptions', await visit(), { ad: true, tracker: false, normal: false })
  check('and can hide things on a page', await until(() => tab.webContents.executeJavaScript(`getComputedStyle(document.getElementById('mine')).display === 'none'`), 2000))
  blocker.setCustomRules('')
  equal('and clearing them goes back to normal', await visit(), { ad: false, tracker: false, normal: true })

  // The real switches, through the toolbar.
  shell.peek()
  await ui(shell, `document.getElementById('shield-btn').click()`)
  check('the shield opens its panel', await until(() => ui(shell, `!document.getElementById('shield-panel').hidden`), 1000))
  await until(() => uiHeight() === win.getContentSize()[1], 1000)
  await wait(100)
  equal('it shows this site', await ui(shell, `document.getElementById('shield-site').textContent.startsWith('On for 127.0.0.1')`), true)
  equal('and the counts', await ui(shell, `document.getElementById('shield-total').textContent`), '2 blocked on this page')
  const reloaded = new Promise((resolve) => tab.webContents.once('did-stop-loading', resolve))
  hits.length = 0
  await ui(shell, `document.getElementById('shield-ads-switch').click()`)
  await Promise.race([reloaded, wait(3000)])
  await wait(350)
  equal('the ads switch applies and reloads', [blocker.getSettings().ads, hits.includes('/banner-ad.js')], [false, true])
  await ui(shell, `document.getElementById('shield-ads-switch').click()`)
  await wait(400)

  // The whitelist page, through its own buttons.
  await ui(shell, `document.getElementById('shield-manage').click()`)
  check('the panel opens the protection page', await until(() => shell.activeTab().url.startsWith('glasswing://protection'), 1500))
  const pageTab = shell.activeTab()
  await until(() => !pageTab.webContents.isLoading())
  const onPage = (code) => pageTab.webContents.executeJavaScript(code, true)
  check('the page loads its settings', await until(() => onPage(`document.getElementById('ads').classList.contains('on') && document.getElementById('total').textContent.includes('blocked so far')`), 1500))
  await onPage(`(() => { const i = document.getElementById('site'); i.value = 'https://www.Example.com/some/page'; document.getElementById('add-site').requestSubmit() })()`)
  check('adding a site tidies it up', await until(() => blocker.getSettings().allowedSites.includes('example.com'), 1500))
  check('and lists it', await until(() => onPage(`document.getElementById('sites').textContent.includes('example.com')`), 1000))
  equal('subdomains count', blocker.stateFor('https://shop.example.com/').allowed, true)
  await onPage(`(() => { const i = document.getElementById('site'); i.value = 'not a site!'; document.getElementById('add-site').requestSubmit() })()`)
  await wait(300)
  equal('rejects something that isn\'t a site', blocker.getSettings().allowedSites, ['example.com'])
  await onPage(`document.querySelector('#sites .danger').click()`)
  check('removing works', await until(() => blocker.getSettings().allowedSites.length === 0, 1500))
  await onPage(`(() => { document.getElementById('rules').value = '||rules.test^'; document.getElementById('rules').dispatchEvent(new Event('input')); document.getElementById('save-rules').click() })()`)
  check('rules save from the page', await until(() => blocker.getSettings().customRules === '||rules.test^', 1500))
  await onPage(`(() => { document.getElementById('rules').value = ''; document.getElementById('save-rules').click() })()`)
  await until(() => blocker.getSettings().customRules === '', 1500)
  const forged = await tab.webContents.executeJavaScript(`fetch('glasswing://protection/api/protection/allowed', { method: 'POST', body: '{"site":"evil.test"}' }).then((r) => r.status).catch(() => 'blocked')`)
  check('websites can\'t change the whitelist', forged !== 200 && !blocker.getSettings().allowedSites.includes('evil.test'), String(forged))
  shell.closeTab(pageTab.id)
  shell.selectTab(tab.id)
  await until(() => ui(shell, `!document.body.classList.contains('expanded')`), 1000)

  shell.toggleProtection()
  equal('Ctrl+Shift+A turns everything off', [blocker.getSettings().ads, blocker.getSettings().trackers], [false, false])
  await wait(300)
  equal('nothing is blocked then', await visit(), { ad: true, tracker: true, normal: true })
  shell.toggleProtection()
  equal('and back on', [blocker.getSettings().ads, blocker.getSettings().trackers], [true, true])
  await wait(300)
  shell.selectTab(tab.id)

  console.log('\nCamera, microphone and sound icons')
  const profileStore = require(path.join(REPO, 'src/main/store.js'))
  const port = server.address().port
  profileStore.set('permissions', { ...profileStore.get('permissions'), [`${base} media`]: true, [`http://localhost:${port} media`]: false })
  const media = shell.createTab({ url: `${base}/media` })
  await until(() => !media.webContents.isLoading())
  await wait(200)
  const inPage = (code) => media.webContents.executeJavaScript(code, true)
  const iconsOn = async (selector) => ui(shell, `(() => { const c = document.querySelector('${selector}'); return c.hidden ? 0 : c.querySelectorAll('svg').length })()`)
  const uses = (t = media) => [t.state().camera, t.state().microphone]
  equal('a page that isn\'t recording shows nothing', uses(), [false, false])
  equal('and no icon in the address field', await iconsOn('#address-capture'), 0)

  check('the toolbar is out of sight before recording starts', await until(() => !shell.revealed, 3000))
  await inPage(`navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { window.cam = s; return s.getTracks().length })`)
  equal('the camera shows as in use', uses(), [true, false])
  check('the toolbar comes down to show it', shell.revealed)
  check('the address field shows the camera', await until(async () => (await iconsOn('#address-capture')) === 1))
  equal('its label says so', await ui(shell, `document.getElementById('address-capture').title`), 'Using your camera')
  await wait(1500)
  equal('still on after the page reports in', uses(), [true, false])

  await inPage(`navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { window.mic = s; return true })`)
  equal('the microphone too', uses(), [true, true])
  check('both icons in the address field', await until(async () => (await iconsOn('#address-capture')) === 2))

  const away = shell.createTab({ url: `${base}/dark` })
  check('a background tab keeps both icons', await until(async () => (await iconsOn(`.tab[data-id="${media.id}"] > .capture`)) === 2))
  shell.closeTab(away.id)
  shell.selectTab(media.id)

  await inPage(`window.cam.getTracks().forEach((t) => t.stop()); 1`)
  check('stopping the camera turns its icon off', await until(() => !media.usingCamera, 3000))
  equal('and leaves the microphone on', uses(), [false, true])

  await inPage(`window.copy = window.mic.getAudioTracks()[0].clone(); window.mic.getTracks().forEach((t) => t.stop()); 1`)
  await wait(1500)
  equal('a copy of the track still counts', uses(), [false, true])
  await inPage(`window.copy.stop(); 1`)
  check('stopping the copy turns it off', await until(() => !media.usingMicrophone, 3000))
  check('the icons go away', await until(async () => (await iconsOn('#address-capture')) === 0))

  const failed = await inPage(`navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: 'no-such-camera' } } }).then(() => 'worked', (e) => e.name)`)
  check('a request that fails', failed !== 'worked', failed)
  check('doesn\'t leave an icon on', await until(() => !media.usingCamera, 2000))

  await inPage(`navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { window.cam = s; return true })`)
  equal('on again', uses(), [true, false])
  await load(media, `${base}/white`)
  equal('leaving the page turns it off', uses(), [false, false])

  await load(media, `${base}/media`)
  const inner = media.webContents.mainFrame.frames[0]
  await inner.executeJavaScript(`navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { window.mic = s; return true })`, true)
  equal('an embedded frame recording is noticed', uses(), [false, true])
  await inPage(`navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return true })`)
  check('the page stopping its own camera is seen', await until(() => !media.usingCamera, 3000))
  equal('and doesn\'t hide what the frame is doing', uses(), [false, true])
  await load(media, `${base}/white`)
  equal('until the page changes', uses(), [false, false])

  const refused = shell.createTab({ url: `http://localhost:${port}/media` })
  await until(() => !refused.webContents.isLoading())
  await wait(200)
  const denied = await refused.webContents.executeJavaScript(`navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(() => 'worked', (e) => e.name)`, true)
  equal('a blocked site gets no camera', denied, 'NotAllowedError')
  equal('and shows no icon', uses(refused), [false, false])
  shell.closeTab(refused.id)

  // Quiet enough that nobody would hear it (-60 dB), loud enough to count as playing sound.
  await load(media, `${base}/media`)
  await inPage(`(() => { const a = new AudioContext(); const o = a.createOscillator(); const g = a.createGain(); g.gain.value = 0.001; o.connect(g).connect(a.destination); o.start(); window.tone = a; return a.resume().then(() => a.state) })()`)
  check('a tab playing sound is noticed', await until(() => media.state().audible, 4000))
  check('the address field shows the speaker', await until(() => ui(shell, `!document.getElementById('address-audio').hidden`)))
  await ui(shell, `document.getElementById('address-audio').click()`)
  check('clicking it mutes the tab', await until(() => media.webContents.isAudioMuted()))
  check('and the icon says muted', await until(() => ui(shell, `document.getElementById('address-audio').title === 'Unmute Tab'`)))
  await ui(shell, `document.getElementById('address-audio').click()`)
  check('clicking again unmutes', await until(() => !media.webContents.isAudioMuted()))
  const behind = shell.createTab({ url: `${base}/dark` })
  check('a background tab shows the speaker', await until(() => ui(shell, `!document.querySelector('.tab[data-id="${media.id}"] > .tab-audio').hidden`)))
  shell.closeTab(behind.id)
  shell.closeTab(media.id)
  shell.selectTab(tab.id)

  console.log('\nZoom')
  shell.selectTab(tab.id)
  await load(tab, `${base}/zoom`)
  tab.zoom(1)
  check('zoom indicator appears', await until(() => ui(shell, `!document.getElementById('zoom-pill').hidden`)))
  tab.zoom(0)
  check('resetting zoom clears the indicator', await until(() => ui(shell, `document.getElementById('zoom-pill').hidden`)))

  console.log('\nInternal pages')
  for (const [url, needle] of [['glasswing://history/', 'History'], ['glasswing://extensions/', 'Extensions'], ['glasswing://passwords/', 'Passwords']]) {
    const t = shell.createTab({ url })
    await until(() => !t.webContents.isLoading())
    await wait(300)
    check(`${url} loads`, (await t.webContents.executeJavaScript('document.body.innerText')).includes(needle))
    shell.closeTab(t.id)
  }
  const internal = shell.createTab()
  await until(() => !internal.webContents.isLoading())
  const before2 = favorites.list().length
  favorites.add({ title: 'Live', url: 'https://live.test/' })
  check('open new tab page updates live', await until(() => internal.webContents.executeJavaScript(`document.querySelectorAll('.fav:not(.add)').length === ${before2 + 1}`)))
  favorites.remove('https://live.test/')
  shell.closeTab(internal.id)

  console.log('\nClicking the top of a page')
  const toolbarDrags = () => ui(shell, `getComputedStyle(document.querySelector('#toolbar')).webkitAppRegion === 'drag'`)
  shell.selectTab(tab.id)
  await until(() => !shell.revealed && uiHeight() === 0)
  check('with the toolbar hidden, the top of the page does not move the window', await until(async () => !(await toolbarDrags())))
  moveCursor(200, 0)
  await until(() => shell.revealed)
  check('with it showing, its gaps do', await until(toolbarDrags))
  moveCursor(640, 500)
  await until(() => !shell.revealed && uiHeight() === 0)
  check('and hidden again, they stop', await until(async () => !(await toolbarDrags())))

  // Empty parts of the toolbar view: the page underneath gets the press.
  const passedOn = []
  const realSend = tab.webContents.sendInputEvent.bind(tab.webContents)
  tab.webContents.sendInputEvent = (event) => { if (event.type !== 'mouseMove' || event.modifiers) passedOn.push(event.type) }
  const onBody = (type, buttons) => ui(shell, `document.body.dispatchEvent(new MouseEvent('${type}', { bubbles: true, button: 0, buttons: ${buttons}, clientX: 900, clientY: 90, detail: 1 }))`)
  const pressBody = async () => {
    await onBody('mousedown', 1)
    await onBody('mousemove', 1)
    await onBody('mouseup', 0)
    await wait(100)
    return passedOn.splice(0)
  }
  moveCursor(200, 0)
  await until(() => shell.revealed)
  await until(() => ui(shell, `document.body.classList.contains('revealed')`))
  equal('a press in an empty part reaches the page', await pressBody(), ['mouseDown', 'mouseMove', 'mouseUp'])
  moveCursor(640, 500)
  check('and sends the toolbar away', await until(() => !shell.revealed && uiHeight() === 0))
  moveCursor(200, 0)
  await until(() => shell.revealed)
  await ui(shell, `document.querySelector('#fav-pill').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, clientX: 300, clientY: 60 }))`)
  await ui(shell, `window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 300, clientY: 60 }))`)
  await wait(100)
  equal('a press on the toolbar\'s own pieces does not', passedOn.splice(0), [])
  await ui(shell, `expanded = true`)
  equal('nor does one with a dropdown open', await pressBody(), [])
  await ui(shell, `expanded = false`)
  moveCursor(640, 500)
  await until(() => !shell.revealed && uiHeight() === 0)
  appearance.update({ autoHide: false })
  await until(() => ui(shell, `!document.body.classList.contains('chrome-hidden')`))
  equal('nor one with auto-hide off, where no page is underneath', await pressBody(), [])
  appearance.update({ autoHide: true })
  await until(() => !shell.revealed && uiHeight() === 0)
  tab.webContents.sendInputEvent = realSend

  console.log('\nFull-screen video')
  shell.htmlFullscreen = true
  shell.layout()
  equal('toolbar is fully out of the way', uiHeight(), 0)
  moveCursor(200, 0)
  await wait(250)
  check('the top edge does not bring it down', shell.revealed === false)
  shell.setExpanded(true)
  check('but prompts and menus can still show', uiHeight() > 0)
  shell.setExpanded(false)
  moveCursor(640, 500)
  shell.htmlFullscreen = false
  shell.layout()

  console.log('\nSettings')
  appearance.update({ favoritesBar: false })
  await wait(100)
  check('favorites bar can be turned off', await until(() => ui(shell, `!document.body.classList.contains('favbar-open')`)))
  appearance.update({ favoritesBar: true })
  appearance.update({ autoHide: false })
  await wait(200)
  const pinned = tab.view.getBounds()
  check('auto-hide off: page sits below the elements', pinned.y === 48 + 36, JSON.stringify(pinned))
  equal('auto-hide off: view is exactly the elements', uiHeight(), 48 + 36)
  check('auto-hide off: the gaps move the window', await until(toolbarDrags))
  shell.htmlFullscreen = true
  shell.layout()
  shell.scheduleState()
  check('auto-hide off: nothing moves the window over a full-screen video', await until(async () => !(await toolbarDrags())))
  shell.htmlFullscreen = false
  shell.layout()
  shell.scheduleState()
  check('auto-hide off: and the gaps work again afterwards', await until(toolbarDrags))
  await shot(shell, '10-pinned')
  appearance.update({ autoHide: true })
  check('auto-hide back on: page is edge to edge', await until(() => tab.view.getBounds().y === 0))

  if (testWindowStates) {
    console.log('\nWindow controls and full screen')
    await ui(shell, `window.glasswing.send('window', 'maximize')`)
    check('green button maximizes', await until(() => win.isMaximized(), 3000))
    await ui(shell, `window.glasswing.send('window', 'maximize')`)
    check('and restores', await until(() => !win.isMaximized(), 3000))
    win.setFullScreen(true)
    await until(() => win.isFullScreen(), 3000)
    await wait(400)
    moveCursor(640, 0)
    check('reveal works in full screen', await until(() => shell.revealed, 1000))
    await wait(450)
    await shot(shell, '11-fullscreen')
    await ui(shell, `window.glasswing.send('window', 'maximize')`)
    check('green button leaves full screen', await until(() => !win.isFullScreen(), 3000))
    moveCursor(640, 500)
    shell.setHtmlFullscreen(true)
    await until(() => win.isFullScreen(), 3000)
    await wait(400)
    equal('a full-screen video takes the whole window', uiHeight(), 0)
    shell.setHtmlFullscreen(false)
    await until(() => !win.isFullScreen(), 3000)
    await wait(400)
  } else {
    console.log('\n(maximize and full screen skipped; pass --window-states to include them)')
  }

  console.log('\nSigning in with Google')
  {
    // A stand-in for Google, so this needs no network, and can't say whether the real Google accepts it.
    // Secure pages are the ones that send brand signals.
    const signInTab = shell.createTab({ url: `${base}/before-sign-in` })
    const wc = signInTab.webContents
    await until(() => wc.getURL().endsWith('/before-sign-in') && !wc.isLoading())
    const ses = wc.session
    const html = (body) => new Response(body, { headers: { 'content-type': 'text/html' } })
    ses.protocol.handle('https', (request) => {
      const { pathname } = new URL(request.url)
      if (new URL(request.url).hostname === 'no-secure-version.test') return Response.error()
      if (pathname === '/out') return new Response(null, { status: 302, headers: { location: `${base}/after-sign-in` } })
      if (pathname === '/to-sign-in') return new Response(null, { status: 302, headers: { location: signIn } })
      if (pathname === '/signin') return html('<title>Fake sign-in</title><h1>Sign in</h1><script src="https://ssl.gstatic.com/sign-in.js"></script>')
      if (pathname === '/embed') return html('<title>Embeds Google</title><iframe src="https://accounts.google.com/frame"></iframe>')
      if (pathname.endsWith('.js')) return new Response('', { headers: { 'content-type': 'text/javascript' } })
      return html('<title>Plain secure page</title>')
    })
    const signIn = 'https://accounts.google.com/signin'
    const failed = []
    const onFail = (_e, code, _d, url, isMainFrame) => {
      if (isMainFrame) failed.push(`${code} ${url}`)
    }
    wc.on('did-fail-load', onFail)
    const arrive = async (url, go) => {
      go()
      const ok = await until(() => wc.getURL() === url && !wc.isLoading())
      await wait(300) // long enough for an error page drawn over the real one to show up
      return ok
    }
    const seen = () => wc.executeJavaScript(`({ title: document.title, real: navigator.userAgent.includes('Electron/'), appVersion: navigator.appVersion.includes('Electron/'), brands: 'userAgentData' in navigator, chrome: 'chrome' in window })`)
    const asItself = { title: 'Fake sign-in', real: true, appVersion: true, brands: true, chrome: true }

    check('going to sign-in arrives', await arrive(signIn, () => signInTab.navigate(signIn)))
    equal('with no failed load', failed, [])
    equal('and the page isn\'t covered, and sees the real browser', await seen(), asItself)
    const google = require(path.join(REPO, 'src/main/google-signin.js'))
    const headers = (url, resourceType) => (google.usesSignInIdentity({ url, resourceType, webContents: wc }) ? 'real' : 'chrome')
    equal('Google sign-in gets the real browser for the page', headers(signIn, 'mainFrame'), 'real')
    equal('and for what the page loads', headers('https://ssl.gstatic.com/sign-in.js', 'script'), 'real')
    equal('with Chromium\'s own brand signals left alone', google.signInHeaders({ 'user-agent': 'Chrome', 'Sec-CH-UA': 'a', Accept: '*/*' }), { 'User-Agent': google.signInUserAgent(), 'Sec-CH-UA': 'a', Accept: '*/*' })
    check('naming the engine, not disguised as another browser', /Chrome\/\d+\.\d+\.\d+\.\d+ Electron\/\d/.test(google.signInUserAgent()) && !google.signInUserAgent().includes('Firefox/'), google.signInUserAgent())
    equal('the page reads exactly what its requests say', await wc.executeJavaScript('navigator.userAgent'), google.signInUserAgent())
    check('the sign-in script can\'t freeze a page waiting for an answer', !fs.readFileSync(path.join(REPO, 'src/preload/google-signin.js'), 'utf8').includes('sendSync'))

    wc.reload()
    await wait(100)
    await until(() => !wc.isLoading())
    await wait(300)
    equal('reloading it stays fine', [failed, await seen()], [[], asItself])

    await arrive(`${base}/after-sign-in`, () => signInTab.navigate('https://accounts.google.com/out'))
    equal('being sent back to a site works', failed, [])
    check('and that site gets Chrome again', !(await wc.executeJavaScript('navigator.userAgent')).includes('Electron/'))
    check('going back to sign-in works', await arrive(signIn, () => wc.navigationHistory.goBack()))
    equal('with no failed load', [failed, await seen()], [[], asItself])

    await arrive(`${base}/before-sign-in`, () => signInTab.navigate(`${base}/before-sign-in`))
    check('a site that redirects to sign-in gets there', await arrive(signIn, () => signInTab.navigate('https://example.test/to-sign-in')), wc.getURL())
    equal('with no failed load', [failed, await seen()], [[], asItself])

    const other = 'https://example.test/embed'
    await arrive(other, () => signInTab.navigate(other))
    equal('other sites get Chrome', headers(other, 'mainFrame'), 'chrome')
    check('and see Chrome', !(await wc.executeJavaScript('navigator.userAgent')).includes('Electron/') && (await wc.executeJavaScript(`'chrome' in window`)))
    equal('Google embedded in another site stays Chrome', headers('https://accounts.google.com/frame', 'subFrame'), 'chrome')

    console.log('\nPrivacy')
    const privacy = require(path.join(REPO, 'src/main/privacy.js'))
    equal('websites can\'t read your local network address', wc.getWebRTCIPHandlingPolicy(), 'default_public_interface_only')
    const secure = 'https://example.test/plain'
    // Only the address: a redirect goes around the stand-in. The fallback below follows the real one.
    equal('a plain address moves to https', privacy.saferUrl('http://moves.test/plain?a=1'), 'https://moves.test/plain?a=1')
    check('tracking tags come off the address', await arrive(`${secure}?keep=1#top`, () => signInTab.navigate(`${secure}?utm_source=a&keep=1&fbclid=b#top`)), wc.getURL())
    check('an address that was only tags ends up clean', await arrive(secure, () => signInTab.navigate(`${secure}?utm_medium=a&gclid=b`)), wc.getURL())
    equal('everything else stays exactly as written', privacy.saferUrl('https://a.test/x?q=a+b%20c&ref=me&id=7'), null)
    equal('tags can be left on', privacy.saferUrl('https://a.test/?utm_source=a', { stripTrackers: false }), null)
    equal('your own network stays plain', [privacy.saferUrl('http://192.168.1.1/'), privacy.saferUrl('http://router/'), privacy.saferUrl('http://nas.local/'), privacy.saferUrl('http://localhost/')], [null, null, null, null])
    equal('and so does an address with a port', privacy.saferUrl('http://a.test:8080/'), null)
    equal('other kinds of address are left alone', privacy.saferUrl('glasswing://newtab/?utm_source=a'), null)
    blocker.allowSite('example.test')
    const excepted = `${secure}?utm_source=a`
    check('a site with the shield off keeps its tags', await arrive(excepted, () => signInTab.navigate(excepted)), wc.getURL())
    blocker.removeAllowedSite('example.test')
    await until(() => !wc.isLoading())
    failed.length = 0
    signInTab.navigate('http://no-secure-version.test/page')
    check('a site with no secure version falls back to plain', await until(() => failed.some((f) => f.includes('http://no-secure-version.test/page')), 8000), JSON.stringify(failed))
    check('after trying the secure one first', failed.some((f) => f.includes('https://no-secure-version.test/page')), JSON.stringify(failed))
    equal('and isn\'t sent back to https', privacy.saferUrl('http://no-secure-version.test/page'), null)
    await until(() => !wc.isLoading())
    failed.length = 0

    wc.off('did-fail-load', onFail)
    ses.protocol.unhandle('https')
    shell.closeTab(signInTab.id)
    await wait(100)
  }

  console.log('\nUsername and password boxes')
  {
    const prompt = (title) => ui(shell, `[...document.querySelectorAll('.prompt:not(.leaving)')].find((p) => p.querySelector('.prompt-title')?.textContent === ${JSON.stringify(title)})?.textContent ?? ''`)
    const answer = (label, user = '', pass = '') => ui(shell, `(() => {
      const card = [...document.querySelectorAll('.prompt:not(.leaving)')].pop()
      const inputs = card.querySelectorAll('.prompt-field input')
      if (inputs[0]) inputs[0].value = ${JSON.stringify(user)}
      if (inputs[1]) inputs[1].value = ${JSON.stringify(pass)}
      ;[...card.querySelectorAll('.btn')].find((b) => b.textContent === ${JSON.stringify(label)}).click()
    })()`)
    const signIn = shell.createTab({ url: `${base}/login-a` })
    const swc = signIn.webContents
    check('a site that asks gets a box', await until(async () => (await prompt('Sign in')).includes('wants a username and password'), 4000))
    check('the password is hidden as you type', await ui(shell, `Boolean(document.querySelector('.prompt:not(.leaving) .prompt-field input[type=password]'))`))
    check('it warns when the connection isn\'t encrypted', (await prompt('Sign in')).includes('isn’t encrypted'))
    await answer('Sign In', 'me', 'wrong')
    check('a wrong password asks again and says so', await until(async () => (await prompt('Sign in')).includes('That didn’t work'), 4000))
    await answer('Sign In', 'me', 'secret')
    check('the right one opens the page', await until(() => swc.getTitle() === 'Signed in', 4000), swc.getTitle())
    // Another host: the browser now rightly remembers the login for this one.
    signIn.navigate(`${base.replace('127.0.0.1', 'localhost')}/login-b`)
    await until(async () => (await prompt('Sign in')).includes('wants a username'), 4000)
    await answer('Cancel')
    check('cancelling shows the site\'s own page', await until(() => swc.getTitle() === 'Login needed', 4000), swc.getTitle())
    signIn.navigate(`${base}/login-embed?src=${encodeURIComponent(`${base.replace('127.0.0.1', 'localhost')}/login-c`)}`)
    await until(() => swc.getTitle() === 'Embeds a login', 4000)
    await wait(700)
    equal('an image from another site can\'t ask', await prompt('Sign in'), '')

    console.log('\nA page that stops responding')
    const title = 'This page isn’t responding'
    swc.emit('unresponsive')
    check('you get a way out', await until(async () => (await prompt(title)).length > 0))
    swc.emit('unresponsive')
    await wait(150)
    equal('only one card at a time', await ui(shell, `[...document.querySelectorAll('.prompt:not(.leaving) .prompt-title')].filter((t) => t.textContent === ${JSON.stringify(title)}).length`), 1)
    swc.emit('responsive')
    check('and it goes away if the page recovers', await until(async () => (await prompt(title)) === ''))
    await wait(250)
    swc.emit('unresponsive')
    await until(async () => (await prompt(title)).length > 0)
    await answer('Wait')
    check('Wait leaves the page alone', await until(async () => (await prompt(title)) === '') && !swc.isCrashed())
    await wait(250)
    swc.emit('unresponsive')
    await until(async () => (await prompt(title)).length > 0)
    await answer('Reload')
    check('Reload brings the page back', await until(() => !swc.isCrashed() && !swc.isLoading() && swc.getTitle() === 'Embeds a login', 6000), swc.getTitle())
    equal('without a crash message on top', await prompt('This page stopped working'), '')
    const background = shell.createTab({ url: `${base}/white`, active: false })
    await until(() => !background.webContents.isLoading())
    background.webContents.emit('unresponsive')
    await wait(200)
    equal('a tab you aren\'t looking at doesn\'t interrupt you', await prompt(title), '')
    shell.closeTab(background.id)
    shell.closeTab(signIn.id)
    await wait(100)
  }

  console.log('\nYouTube\'s player')
  {
    const { reloadsYouTubePlayer } = require(path.join(REPO, 'src/main/blocker.js'))
    check('the filter list script that restarts videos doesn\'t run', reloadsYouTubePlayer('x(`e\\.loadVideoById\\(o%2Cs\\)`,`%22onSnackbarMessage%22`)'))
    check('scripts that remove ads still do', !reloadsYouTubePlayer('setConstant(`ytInitialPlayerResponse\\.playerAds`,`undefined`)'))
  }

  console.log('\nPrivate windows')
  {
    const { session } = electron
    const history = require(path.join(REPO, 'src/main/history.js'))
    const blocker = require(path.join(REPO, 'src/main/blocker.js'))
    const shortcuts = require(path.join(REPO, 'src/main/shortcuts.js'))
    const tabDrag = require(path.join(REPO, 'src/main/tab-drag.js'))
    const storeNow = require(path.join(REPO, 'src/main/store.js'))
    const MARKER = 'privatemarker7f3a'
    const NORMAL_MARKER = 'normalmarker7f3a'
    const loaded = (wc) => until(() => !wc.isLoading(), 5000)
    const inPage = (wc, code) => wc.executeJavaScript(code, true)

    const count = BrowserShell.all.size
    shortcuts.handle(shell, { type: 'keyDown', control: true, shift: true, alt: false, meta: false, key: 'N' })
    const priv = [...BrowserShell.all].find((s) => s.private)
    check('Ctrl+Shift+N opens a private window', Boolean(priv) && BrowserShell.all.size === count + 1)
    const ptab = priv.activeTab()
    const pwc = ptab.webContents
    const pses = pwc.session
    check('its session is kept in memory only', pses !== session.defaultSession && !pses.isPersistent() && pses.getStoragePath() == null, String(pses.getStoragePath()))
    check('its toolbar shares that session', priv.ui.webContents.session === pses)
    await until(() => ui(priv, `document.body.classList.contains('private')`).catch(() => false))
    check('the toolbar says it is private', await ui(priv, `getComputedStyle(document.getElementById('private-badge')).display !== 'none'`))
    check('a normal window doesn\'t', await ui(shell, `getComputedStyle(document.getElementById('private-badge')).display === 'none'`))
    equal('the window\'s name says so too', priv.win.getTitle(), 'Glasswing (Private)')
    check('the ⋯ menu offers one', await ui(shell, `Boolean(document.querySelector('[data-action="new-private-window"]'))`))
    await until(() => inPage(pwc, `!document.getElementById('private-note')?.hidden`).catch(() => false))
    check('its new tab page explains what\'s kept', await inPage(pwc, `/forgets the pages/.test(document.getElementById('private-note').textContent) && !document.getElementById('private-note').hidden`))

    const ntab = shell.createTab({ url: 'glasswing://newtab/' })
    await loaded(ntab.webContents)
    await wait(200)
    check('a normal new tab page doesn\'t show that', await inPage(ntab.webContents, `document.getElementById('private-note').hidden`))
    shell.closeTab(ntab.id)

    ptab.navigate(`${base}/${MARKER}`)
    await until(() => pwc.getTitle().includes(MARKER), 5000)
    await inPage(pwc, `document.cookie = 'who=${MARKER}; max-age=99999'; localStorage.setItem('who', '${MARKER}'); 1`)
    equal('pages load with the same browser identity', pwc.getUserAgent(), shell.activeTab().webContents.getUserAgent())
    await wait(300)
    check('it stays out of history', !JSON.stringify(history.list({ search: MARKER, offset: 0, limit: 10 })).includes(MARKER) && !JSON.stringify(history.query(MARKER, 8)).includes(MARKER))
    equal('its cookie stays out of normal browsing', (await session.defaultSession.cookies.get({ name: 'who' })).length, 0)
    equal('it can read its own cookie', (await pses.cookies.get({ name: 'who' })).length, 1)
    await session.defaultSession.cookies.set({ url: base, name: 'mine', value: 'normal' })
    equal('normal cookies stay out of it', (await pses.cookies.get({ name: 'mine' })).length, 0)
    await session.defaultSession.cookies.remove(base, 'mine')

    const normalTab = shell.createTab({ url: `${base}/${NORMAL_MARKER}` })
    await loaded(normalTab.webContents)
    await wait(200)
    const suggest = (from, text) => ui(from, `window.glasswing.invoke('suggest-local', ${JSON.stringify(text)})`)
    equal('normal windows don\'t suggest its tabs', (await suggest(shell, MARKER)).tabs.length, 0)
    equal('it doesn\'t suggest normal tabs', (await suggest(priv, NORMAL_MARKER)).tabs.length, 0)
    equal('or your history', (await suggest(priv, NORMAL_MARKER)).history.length, 0)
    equal('typing isn\'t sent to the search engine', await ui(priv, `window.glasswing.invoke('suggest-search', 'anything')`), [])
    shell.closeTab(normalTab.id)

    BrowserShell.saveSession()
    check('it isn\'t saved with your session', !JSON.stringify(storeNow.get('session')).includes(MARKER))
    equal('even as the only window open, your session is kept', (() => {
      const before = JSON.stringify(storeNow.get('session'))
      const all = [...BrowserShell.all]
      BrowserShell.all.clear()
      BrowserShell.all.add(priv)
      BrowserShell.saveSession()
      BrowserShell.all.clear()
      for (const s of all) BrowserShell.all.add(s)
      return JSON.stringify(storeNow.get('session')) === before
    })(), true)
    BrowserShell.focused = priv
    check('links from other apps go to a normal window', BrowserShell.lastNormal() === shell)

    const hitsBefore = hits.length
    ptab.navigate(`${base}/ads`)
    await until(() => pwc.getTitle() === 'Ads', 5000)
    await wait(300)
    const pageHits = hits.slice(hitsBefore)
    check('ads and trackers are blocked here too', pageHits.includes('/normal.js') && !pageHits.includes('/banner-ad.js') && !pageHits.includes('/tracker-pixel.gif'), pageHits.join(' '))
    const preloads = pses.getPreloadScripts().map((p) => p.id)
    check('saved passwords can\'t be filled in', !preloads.includes('glasswing-autofill'), preloads.join(' '))
    check('sign-in and the camera icons still work', preloads.includes('glasswing-google-signin') && preloads.includes('glasswing-capture'), preloads.join(' '))

    // Permissions
    ptab.navigate(`${base}/permissions`)
    await until(() => pwc.getTitle().includes('/permissions'), 5000)
    const permissionsBefore = JSON.stringify(storeNow.get('permissions'))
    pwc.executeJavaScript(`Notification.requestPermission()`, true).catch(() => {})
    const askedHere = await until(() => ui(priv, `Boolean([...document.querySelectorAll('.prompt:not(.leaving)')].find((p) => p.textContent.includes('show notifications')))`), 4000)
    check('sites have to ask', askedHere)
    equal('with no offer to remember', await ui(priv, `document.querySelectorAll('.prompt:not(.leaving) input[type=checkbox]').length`), 0)
    await ui(priv, `[...[...document.querySelectorAll('.prompt:not(.leaving)')].pop().querySelectorAll('.btn')].find((b) => b.textContent === 'Allow').click()`)
    await wait(300)
    equal('and nothing is saved', JSON.stringify(storeNow.get('permissions')), permissionsBefore)

    // Popups, like "Sign in with Google", stay on the private side.
    const before = new Set(BrowserWindow.getAllWindows())
    await inPage(pwc, `window.open(${JSON.stringify(`${base}/popup`)}, '_blank', 'width=320,height=320'); 1`)
    await until(() => BrowserWindow.getAllWindows().some((w) => !before.has(w)), 3000)
    const popup = BrowserWindow.getAllWindows().find((w) => !before.has(w))
    check('a popup stays private', popup?.webContents.session === pses)
    popup?.destroy()

    // Downloads
    const dlDir = path.join(profile, 'private-downloads')
    fs.mkdirSync(dlDir, { recursive: true })
    const realDownloads = app.getPath('downloads')
    app.setPath('downloads', dlDir)
    pwc.downloadURL(`${base}/${MARKER}-file.bin`)
    const listOf = (from) => ui(from, `window.glasswing.invoke('downloads')`)
    check('a download shows in the private window', await until(async () => (await listOf(priv)).length === 1, 4000))
    equal('and not in a normal one', (await listOf(shell)).length, 0)

    // Moving tabs
    const second = priv.createTab({ url: `${base}/second-private`, active: false })
    await loaded(second.webContents)
    const moved = priv.moveToNewWindow(second)
    check('a tab moved to its own window stays private', moved?.private === true && second.webContents.session === pses)
    moved.win.close()
    await until(() => !BrowserShell.all.has(moved), 3000)
    const third = priv.createTab({ url: `${base}/third-private`, active: false })
    const shellCount = shell.order.length
    priv.win.setBounds(win.getBounds()) // so the pointer below is over both
    BrowserShell.recent = [shell, priv]
    moveCursor(300, 300)
    tabDrag.start(priv, third.id)
    await wait(60)
    tabDrag.end()
    await wait(100)
    check('dragging a private tab onto a normal window doesn\'t move it', priv.tabs.has(third.id) && shell.order.length === shellCount)
    priv.closeTab(third.id)
    const normalDrag = shell.createTab({ url: `${base}/white`, active: false })
    BrowserShell.recent = [priv, shell]
    tabDrag.start(shell, normalDrag.id)
    await wait(60)
    tabDrag.end()
    await wait(100)
    check('and the same the other way', shell.tabs.has(normalDrag.id) && !priv.tabs.has(normalDrag.id))
    shell.closeTab(normalDrag.id)
    BrowserShell.recent = [shell]
    BrowserShell.focused = shell
    moveCursor(600, 600)

    // Pages about your own data open on the normal side.
    const filler = shell.createTab({ url: `${base}/white` }) // a new tab page would just be reused
    const privTabs = priv.order.length
    menus.runAction(priv, 'history')
    check('History opens in a normal window', await until(() => shell.activeTab().url.startsWith('glasswing://history')) && priv.order.length === privTabs, shell.activeTab().url)
    shell.closeTab(shell.activeId)
    shell.closeTab(filler.id)

    // Closing it
    priv.win.close()
    check('it closes cleanly', await until(() => !BrowserShell.all.has(priv), 3000))
    await until(async () => (await pses.cookies.get({ name: 'who' })).length === 0, 3000)
    equal('its cookies are gone', (await pses.cookies.get({ name: 'who' })).length, 0)
    await wait(250)
    equal('the download is off the list', require(path.join(REPO, 'src/main/downloads.js')).listDownloads(true).length, 0)
    const fileKept = fs.readdirSync(dlDir).some((name) => name.includes(MARKER))
    check('the downloaded file stays', fileKept)
    app.setPath('downloads', realDownloads)
    fs.rmSync(dlDir, { recursive: true, force: true })

    const next = BrowserShell.create({ private: true, urls: [`${base}/next-private`] })
    await loaded(next.activeTab().webContents)
    check('the next private window starts with a new session', next.session !== pses)
    equal('with nothing left over', (await next.session.cookies.get({ name: 'who' })).length, 0)
    equal('including what pages stored', await inPage(next.activeTab().webContents, `localStorage.getItem('who')`), null)
    next.win.close()
    await until(() => !BrowserShell.all.has(next), 3000)

    // The real test: search everything Glasswing wrote to disk for that page.
    shell.createTab({ url: `${base}/${NORMAL_MARKER}` })
    await wait(600)
    BrowserShell.saveSession()
    storeNow.flush()
    await session.defaultSession.flushStorageData()
    await session.defaultSession.cookies.flushStore()
    await wait(300)
    const found = { private: [], normal: [] }
    const search = (folder) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name)
        if (entry.isDirectory()) search(full)
        else {
          try {
            const data = fs.readFileSync(full)
            if (data.includes(MARKER)) found.private.push(path.relative(profile, full))
            if (data.includes(NORMAL_MARKER)) found.normal.push(path.relative(profile, full))
          } catch {} // locked by the browser while it runs
        }
      }
    }
    search(profile)
    check('this search does find a normal visit on disk', found.normal.length > 0)
    equal('and finds nothing from the private one', found.private, [])
    shell.closeTab(shell.activeId)
  }

  console.log('\nDamaged saved data')
  const store = require(path.join(REPO, 'src/main/store.js'))
  store.set('session', { windows: [{ tabs: [{ title: 'no url' }, null], active: 'nonsense', bounds: 'nope' }] })
  check('session stays serializable', Boolean(JSON.stringify(shell.serialize())))

  console.log('\nSecond window and closing')
  const secondWindow = BrowserShell.create({ urls: [`${base}/second-window`] })
  check('a second window opens', await until(() => secondWindow.win.isVisible(), 5000))
  secondWindow.win.close()
  check('and closes cleanly', await until(() => !BrowserShell.all.has(secondWindow), 3000))
  BrowserShell.saveSession()
  check('session saves', store.get('session').windows.length === 1)

  electron.screen.getCursorScreenPoint = realCursor

  // Let any delayed errors surface.
  await wait(500)

  console.log('')
  for (const e of errors) console.log(`ERROR  ${e}`)
  console.log(`${checks - failures.length}/${checks} checks passed, ${errors.length} errors logged`)
  return failures.length === 0 && errors.length === 0
}

// ── Start the real app ───────────────────────────────────────────────────

app.whenReady().then(() =>
  run()
    .then((ok) => finish(ok ? 0 : 1))
    .catch((err) => {
      console.error('Smoke test crashed:', err)
      finish(1)
    }),
)

function finish(code) {
  server.close()
  for (const win of BrowserWindow.getAllWindows()) win.destroy()
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2 })
  } catch {}
  app.exit(code)
}

setTimeout(() => {
  console.error('Smoke test timed out')
  finish(1)
}, 180_000)

require(path.join(REPO, 'src/main/index.js'))
