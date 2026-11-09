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
const { app, BrowserWindow, clipboard, nativeImage, systemPreferences } = require('electron')
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
const showWithoutFocus = BrowserWindow.prototype.showInactive
// Most checks look at where things end up, so movement is off apart from the part of the test that's about it.
let reducedMotion = true
systemPreferences.getAnimationSettings = () => ({ prefersReducedMotion: reducedMotion })
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

// Pages that are waiting for a code from your email, and ones that only look a bit like it. Modeled on common sign-in pages.
const emailCodePages = {
  'yes one-time field': '<p>We sent a code to your email.</p><input autocomplete="one-time-code">',
  'yes masked address': '<form><p>Enter the 6-digit code sent to j***@example.com</p><input name="otp"></form>',
  'yes row of boxes': '<h2>Check your email</h2><div><input maxlength="1"><input maxlength="1"><input maxlength="1"><input maxlength="1"><input maxlength="1"><input maxlength="1"></div>',
  'yes emailed': '<div><h2>Verify it\'s you</h2><p>We emailed you a verification code.</p><label>Code <input></label></div>',
  'yes from your email': '<p>Enter the code from your email to continue</p><input id="verificationCode">',
  'yes email first': '<p>We sent you an email with a 6-digit code.</p><input name="otp">',
  'yes address on its own line': '<p>Enter the code we sent to</p><p>sam@example.com</p><input name="code">',
  'yes email code label': '<label>Email verification code <input id="email_code"></label>',
  'yes numeric only': '<p>Check your inbox for a code.</p><input inputmode="numeric" maxlength="6">',
  'yes curly and caps': '<p>WE’VE SENT A LOGIN CODE TO YOUR EMAIL</p><input placeholder="Login code">',
  'yes appears later': '<p>We sent a code to your email.</p><div id="later"></div><script>setTimeout(() => { document.getElementById("later").innerHTML = "<input name=code>" }, 300)</script>',
  'yes was only hidden': '<p>We sent a code to your email.</p><input id="hidden-code" name="code" style="display:none"><script>setTimeout(() => { const f = document.getElementById("hidden-code"); f.style.display = ""; f.focus() }, 300)</script>',
  'no text message': '<p>We texted a code to ***-1234.</p><input autocomplete="one-time-code">',
  'no authenticator': '<p>Enter the code from your authenticator app.</p><input name="otp">',
  'no text with email as a fallback': '<p>We texted a code to your phone.</p><input name="code"><a href="#">Email me a code instead</a>',
  'no promo code': '<p>We sent a code to your email.</p><input name="promoCode" placeholder="Promo code">',
  'no card security code': '<p>Your receipt will be sent to your email.</p><input autocomplete="cc-csc" name="cvc" placeholder="Security code">',
  'no zip code': '<p>Check your email for updates.</p><input name="zip" placeholder="Zip code">',
  'no code before it is sent': '<p>We will send a code to your email.</p><input name="email" type="email"><button>Send code</button>',
  'no plain login': '<form><input name="email" type="email"><input name="password" type="password"><button>Sign in</button><p>Check your email if you forgot your password</p></form>',
  'no search box': '<p>We sent a code to your email.</p><input type="search" name="q">',
  'no already typed': '<p>We sent a code to your email.</p><input name="code" value="123456">',
  'no code on the page at all': '<article><p>Check your email for the code of conduct.</p></article>',
}

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  const url = new URL(req.url, 'http://x')
  hits.push(url.pathname)
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.gif')) {
    res.setHeader('content-type', 'text/plain')
    return res.end('')
  }
  if (url.pathname.startsWith('/email-code/')) {
    return res.end(page('Sign in', '#fff', emailCodePages[decodeURIComponent(url.pathname.slice(12))] ?? ''))
  }
  if (url.pathname === '/login-form') {
    return res.end(page('Log in', '#fff', '<form id="f" onsubmit="event.preventDefault()"><input id="u" name="username"><input id="p" type="password"><button>Sign in</button></form>'))
  }
  if (url.pathname === '/ads') {
    return res.end(page('Ads', '#fff', '<div class="ad-box" id="box">ad</div><div class="mine" id="mine">mine</div><script src="/banner-ad.js"></script><img src="/tracker-pixel.gif"><script src="/normal.js"></script>'))
  }
  if (url.pathname === '/media') return res.end(page('Media', '#fff', '<iframe id="inner" src="/media-frame" allow="camera;microphone"></iframe>'))
  if (url.pathname === '/form-then-redirect' && req.method === 'POST') {
    res.statusCode = 303
    res.setHeader('location', '/after-form')
    return res.end()
  }
  if (url.pathname === '/split-links') {
    const at = (n) => `style="position:absolute;left:20px;top:${140 + n * 30}px"`
    return res.end(page('Split links', '#fff', `
      <a id="plain" ${at(0)} href="/landed-plain">plain</a>
      <a id="blank" ${at(1)} target="_blank" href="/landed-blank">blank</a>
      <a id="hash" ${at(2)} href="#jump">hash</a>
      <a id="spa" ${at(3)} href="/landed-spa">spa</a>
      <a id="menu" ${at(4)} href="/landed-menu" aria-haspopup="true">menu</a>
      <a id="inner" ${at(5)} href="/landed-inner"><button id="inner-button">inside</button></a>
      <a id="next" ${at(6)} rel="next" href="/landed-next">next</a>
      <a id="shift" ${at(7)} href="/landed-shift">shift</a>
      <a id="ctrl" ${at(8)} href="/landed-ctrl">ctrl</a>
      <a id="alt" ${at(9)} href="/landed-alt">alt</a>
      <div id="host" ${at(10)}></div>
      <script>
        document.getElementById('spa').addEventListener('click', (e) => { e.preventDefault(); window.pageHandled = 'spa' })
        document.getElementById('menu').addEventListener('click', (e) => { e.preventDefault(); window.pageHandled = 'menu' })
        document.getElementById('inner-button').addEventListener('click', (e) => { e.preventDefault(); window.pageHandled = 'inner' })
        document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<a id="shadow" href="/landed-shadow">shadow</a>'
      </script>`))
  }
  if (url.pathname === '/refuses-to-leave') {
    return res.end(page('Refuses', '#fff', `<script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = '' })</script>`))
  }
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
  // A real pointer resting on the window sends real mouse events, which end the pretend drags below.
  const area = electron.screen.getPrimaryDisplay().workArea
  if (testWindowStates && realCursor.call(electron.screen).x < 1340 && area.width >= 2700) {
    win.setBounds({ x: area.x + area.width - 1320, y: 40, width: 1280, height: 800 })
  }
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

  console.log('\nLinks in split view')
  {
    const pair = BrowserShell.create({ urls: [`${base}/split-links`, `${base}/right-side`], fullscreen: false })
    // Real clicks only reach a page in a window that's been shown, so this one is, far off every screen and without focus.
    pair.win.setBounds({ x: -6000, y: -6000, width: 1280, height: 800 })
    showWithoutFocus.call(pair.win)
    await wait(300)
    const [left, right] = pair.order.map((id) => pair.tabs.get(id))
    pair.selectTab(right.id)
    await until(() => !left.webContents.isLoading() && !right.webContents.isLoading() && left.webContents.getURL() && right.webContents.getURL())
    await wait(200)
    const home = () => load(left, `${base}/split-links`)
    const setRight = (url) => load(right, url)
    const opened = () => pair.order.map((id) => pair.tabs.get(id)).filter((t) => t !== left && t !== right)
    const closeOthers = () => opened().forEach((t) => pair.closeTab(t.id))
    pair.splitWith(left.id, right.id, 'left')
    pair.layout()
    await wait(150)

    // Real clicks, the kind a page can't fake.
    const pressAt = async (target, { x, y }, modifiers = []) => {
      const { debugger: cdp } = target.webContents
      if (!cdp.isAttached()) cdp.attach('1.3')
      const held = modifiers.reduce((sum, key) => sum + { alt: 1, control: 2, shift: 8 }[key], 0)
      const mouse = (type) => cdp.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, modifiers: held })
      await mouse('mousePressed')
      await mouse('mouseReleased')
    }
    const spot = (target, selector) => target.webContents.executeJavaScript(`(() => { const r = (${selector}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
    const click = async (id, modifiers) => pressAt(left, await spot(left, `document.getElementById('${id}')`), modifiers)
    const leftPath = () => new URL(left.webContents.getURL()).pathname
    const rightPath = () => new URL(right.webContents.getURL()).pathname

    await click('plain')
    check('a link on the left opens on the right', await until(() => rightPath() === '/landed-plain', 3000), rightPath())
    equal('and the left stays where it was', leftPath(), '/split-links')
    equal('with the left still the side in use', pair.activeId, left.id)
    equal('and no extra tab', pair.order.length, 2)
    await until(() => !right.webContents.isLoading())
    await setRight(`${base}/split-right-links`)
    await right.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', '<a id="back" style="position:absolute;left:20px;top:140px" href="/stays-right">x</a>'); 1`)
    await pressAt(right, await spot(right, `document.getElementById('back')`))
    check('a link on the right stays on the right', await until(() => rightPath() === '/stays-right', 3000), rightPath())
    equal('leaving the left alone', leftPath(), '/split-links')
    await until(() => !right.webContents.isLoading())

    await click('blank')
    check('so does one that would open a new tab', await until(() => rightPath() === '/landed-blank', 3000), rightPath())
    equal('with no new tab', pair.order.length, 2)
    await until(() => !right.webContents.isLoading())

    await click('spa')
    check('so does one the site would handle by itself', await until(() => rightPath() === '/landed-spa', 3000), rightPath())
    equal('before the site can act on it', await left.webContents.executeJavaScript(`window.pageHandled ?? null`), null)
    await until(() => !right.webContents.isLoading())

    const inShadow = await spot(left, `document.getElementById('host').shadowRoot.getElementById('shadow')`)
    await pressAt(left, inShadow)
    check('and one in a shadow DOM', await until(() => rightPath() === '/landed-shadow', 3000), rightPath())
    await until(() => !right.webContents.isLoading())

    const stillOnRight = rightPath()
    await click('hash')
    check('a jump within the page stays here', await until(() => left.webContents.getURL().endsWith('#jump'), 3000), left.webContents.getURL())
    await home()
    await click('menu')
    check('a link that opens a menu acts as one', await until(() => left.webContents.executeJavaScript(`window.pageHandled === 'menu'`), 3000))
    await click('inner-button')
    check('a button inside a link stays a button', await until(() => left.webContents.executeJavaScript(`window.pageHandled === 'inner'`), 3000))
    await click('next')
    check('the next page of a list stays on the list\'s side', await until(() => leftPath() === '/landed-next', 3000), leftPath())
    await home()
    equal('none of those touched the right', rightPath(), stillOnRight)

    await left.webContents.executeJavaScript(`document.getElementById('plain').click(); 1`)
    check('a click the page made up isn\'t treated as yours', await until(() => leftPath() === '/landed-plain', 3000), leftPath())
    equal('and the right is left alone', rightPath(), stillOnRight)
    await home()

    await click('shift', ['shift'])
    check('Shift+click makes a whole new tab', await until(() => opened().some((t) => t.url.endsWith('/landed-shift')), 3000), JSON.stringify(opened().map((t) => t.url)))
    equal('and shows it', pair.activeId, opened()[0]?.id)
    equal('leaving the right as it was', rightPath(), stillOnRight)
    equal('and only one window more', [...BrowserShell.all].filter((s) => s === pair).length, 1)
    closeOthers()
    pair.selectTab(left.id)
    await wait(100)
    await click('ctrl', ['control'])
    check('Ctrl+click makes a tab behind this one', await until(() => opened().some((t) => t.url.endsWith('/landed-ctrl')), 3000))
    equal('and stays here', pair.activeId, left.id)
    closeOthers()
    await wait(100)
    await click('alt', ['alt'])
    check('Alt+click stays on this side', await until(() => leftPath() === '/landed-alt', 3000), leftPath())
    equal('and leaves the right alone', rightPath(), stillOnRight)
    await home()

    // Loading a page gives it the keyboard. Real focus can't happen in a hidden window, so it's stood in for here.
    {
      const rightWc = right.webContents
      const leftWc = left.webContents
      const realFocused = rightWc.isFocused
      const realFocus = leftWc.focus
      let focused = true
      let takenBack = 0
      rightWc.isFocused = () => focused
      leftWc.focus = () => { takenBack += 1 }
      const mouseDown = { type: 'mouseDown' }
      left.keepFocusFrom(right)
      equal('the side you clicked gets the keyboard back', takenBack, 1)
      rightWc.emit('focus')
      equal('and again if the new page takes it as it loads', takenBack, 2)
      focused = false
      rightWc.emit('focus')
      equal('but not if the keyboard has gone somewhere else, like the address bar', takenBack, 2)
      focused = true
      rightWc.emit('input-event', {}, mouseDown)
      rightWc.emit('focus')
      rightWc.emit('did-stop-loading')
      equal('nor once you\'ve used that page yourself', takenBack, 2)
      left.keepFocusFrom(right)
      takenBack = 0
      rightWc.emit('did-stop-loading')
      equal('it checks one last time when the page finishes', takenBack, 1)
      rightWc.emit('focus')
      equal('and then stops', takenBack, 1)
      rightWc.isFocused = realFocused
      leftWc.focus = realFocus
    }

    await right.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', '<textarea id=t></textarea>'); document.getElementById('t').value = 'half a message'; 1`)
    await click('plain')
    check('with text typed on the right, the link opens here instead', await until(() => leftPath() === '/landed-plain', 3000), leftPath())
    equal('and your text is still there', await right.webContents.executeJavaScript(`document.getElementById('t').value`), 'half a message')
    await home()
    await right.webContents.executeJavaScript(`document.getElementById('t').remove(); document.body.insertAdjacentHTML('beforeend', '<input name="q" id="q">'); document.getElementById('q').value = 'cats'; 1`)
    await click('plain')
    check('a search box holding your search doesn\'t count', await until(() => rightPath() === '/landed-plain', 3000), rightPath())
    await until(() => !right.webContents.isLoading())

    const realAudible = right.webContents.isCurrentlyAudible
    right.webContents.isCurrentlyAudible = () => true
    await click('plain')
    check('with sound playing on the right, the link opens here instead', await until(() => leftPath() === '/landed-plain', 3000), leftPath())
    right.webContents.isCurrentlyAudible = realAudible
    await home()

    await setRight(`${base}/refuses-to-leave`)
    await right.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', '<button id="b" style="position:absolute;left:20px;top:140px">b</button>'); 1`)
    await pressAt(right, await spot(right, `document.getElementById('b')`))
    await wait(100)
    await click('plain')
    check('a page on the right that refuses to be left doesn\'t swallow the click', await until(() => leftPath() === '/landed-plain' || rightPath() === '/landed-plain', 4000), `${leftPath()} ${rightPath()}`)
    right.webContents.on('will-prevent-unload', (e) => e.preventDefault())
    await home()
    await setRight(`${base}/right-side`)

    menus.runAction(pair, 'toggle-split-links')
    await wait(50)
    await click('plain')
    check('the switch turns it off', await until(() => leftPath() === '/landed-plain', 3000), leftPath())
    equal('and the right stays', rightPath(), '/right-side')
    menus.runAction(pair, 'toggle-split-links')
    equal('and back on', pair.getState().splitLinks, true)
    check('the ⋯ panel has the switch', await ui(pair, `Boolean(document.getElementById('mp-split-links'))`))
    await home()

    pair.swapSplit()
    await wait(50)
    await pressAt(left, await spot(left, `document.getElementById('plain')`))
    check('swapping sides swaps which side sends links', await until(() => leftPath() === '/landed-plain', 3000), leftPath())
    pair.swapSplit()
    await home()

    pair.unsplit()
    await wait(100)
    pair.selectTab(left.id)
    await wait(100)
    await click('plain')
    check('outside split view, links open as normal', await until(() => leftPath() === '/landed-plain', 3000), leftPath())
    await home()
    await click('shift', ['shift'])
    check('Shift+click makes a tab there too', await until(() => opened().some((t) => t.url.endsWith('/landed-shift')), 3000))
    closeOthers()
    await home()
    const before = BrowserWindow.getAllWindows().length
    await left.webContents.executeJavaScript(`window.open('${base}/popup', '_blank', 'popup,width=400,height=400'); 1`, true)
    check('a sign-in style popup is still a real window', await until(() => BrowserWindow.getAllWindows().length === before + 1, 3000))
    for (const w of BrowserWindow.getAllWindows()) if (![...BrowserShell.all].some((s) => s.win === w)) w.destroy()

    pair.win.close()
    await until(() => !BrowserShell.all.has(pair))
  }

  console.log('\nAnimations')
  {
    reducedMotion = false
    const { SLIDE_MS } = require(path.join(REPO, 'src/main/animations.js'))
    const settled = () => wait(SLIDE_MS + 80)
    const stage = BrowserShell.create({ urls: [`${base}/a-one`, `${base}/a-two`, `${base}/a-three`], fullscreen: false })
    await until(() => stage.order.every((id) => stage.tabs.get(id).webContents.getURL() || stage.tabs.get(id).pendingUrl))
    const [one, two, three] = stage.order.map((id) => stage.tabs.get(id))
    stage.selectTab(two.id)
    await until(() => !two.webContents.isLoading() && two.webContents.getURL())
    await wait(100)
    const inWindow = (t) => stage.win.contentView.children.includes(t.view)
    const topOfWindow = () => stage.win.contentView.children.at(-1)

    // Closing a tab
    const closingHeight = two.view.getBounds().height
    const closingY = two.view.getBounds().y
    stage.closeTab(two.id)
    equal('the tab is gone at once', stage.tabs.has(two.id), false)
    check('and something else is selected at once', stage.activeId != null && stage.activeId !== two.id)
    check('the new page is on screen at once', stage.shownTabs.includes(stage.activeTab()) && inWindow(stage.activeTab()))
    equal('the closing page goes quiet at once', two.webContents.isAudioMuted(), true)
    check('and stays on screen to slide away', inWindow(two))
    equal('with the toolbar still on top', topOfWindow(), stage.ui)
    const children = stage.win.contentView.children
    check('over the new page', children.indexOf(two.view) > children.indexOf(stage.activeTab().view))
    await wait(SLIDE_MS / 2)
    check('it moves without changing size', two.view.getBounds().height === closingHeight && two.view.getBounds().y > closingY, JSON.stringify(two.view.getBounds()))
    check('it\'s gone soon after', await until(() => two.webContents.isDestroyed() && !inWindow(two), SLIDE_MS + 500))

    // Closing a tab that isn't on screen
    const background = stage.createTab({ url: `${base}/a-background`, active: false })
    await until(() => !background.webContents.isLoading())
    stage.closeTab(background.id)
    check('a tab off screen just closes', await until(() => background.webContents.isDestroyed(), 100))

    // Going into split view
    stage.selectTab(one.id)
    await wait(50)
    stage.splitWith(three.id, one.id, 'right')
    const landed = three.rest
    check('the new side starts off to the side', three.view.getBounds().x > landed.x, JSON.stringify(three.view.getBounds()))
    equal('at its final size', three.view.getBounds().width, landed.width)
    check('and the side it joins is in place already', one.view.getBounds().width === one.rest.width && one.view.getBounds().x === one.rest.x)
    stage.layout()
    check('the layout running partway doesn\'t make it jump', three.view.getBounds().x > landed.x)
    stage.win.setBounds({ width: 1100, height: 760 })
    await settled()
    const after = three.rest
    equal('it ends up where it belongs, even if the window changed', three.view.getBounds(), after)
    check('and it moved with the window', after.x !== landed.x)
    stage.win.setBounds({ width: 1280, height: 800 })
    await wait(80)

    // Swapping sides
    const oneX = one.view.getBounds().x
    stage.swapSplit()
    check('swapping slides from where they were', one.view.getBounds().x < one.rest.x && one.view.getBounds().x >= oneX)
    await settled()
    equal('and they end up swapped', [one.view.getBounds(), three.view.getBounds()], [one.rest, three.rest])
    stage.swapSplit()
    await settled()

    // Leaving split view
    stage.selectTab(one.id)
    await wait(30)
    const leaving = three.view.getBounds()
    stage.unsplit()
    check('the page that leaves is still there at first', inWindow(three))
    equal('with the toolbar on top', topOfWindow(), stage.ui)
    equal('the one that stays fills the window at once', one.view.getBounds().width, stage.win.getContentSize()[0])
    equal('the one that leaves hasn\'t changed size', three.view.getBounds().width, leaving.width)
    check('and it\'s out soon after', await until(() => !inWindow(three), SLIDE_MS + 500))
    check('still open, in its tab', !three.webContents.isDestroyed() && stage.tabs.has(three.id))

    // Changing your mind partway
    stage.splitWith(three.id, one.id, 'right')
    await settled()
    stage.unsplit()
    await wait(30)
    stage.selectTab(three.id)
    await settled()
    check('a page picked again as it leaves stays', inWindow(three) && stage.shownTabs.includes(three))
    equal('where it belongs', three.view.getBounds(), three.rest)
    stage.closeTab(one.id)
    await settled()

    // The tab strip
    const stripTab = stage.createTab({ url: `${base}/a-strip`, active: false })
    await until(() => ui(stage, `Boolean(document.querySelector('#tabstrip .tab[data-id="${stripTab.id}"]'))`))
    appearance.update({ autoHide: false })
    await until(() => ui(stage, `!document.body.classList.contains('chrome-hidden')`))
    await wait(50)
    stage.closeTab(stripTab.id)
    check('a closing tab leaves a picture of itself behind', await until(() => ui(stage, `document.querySelector('body > .tab') !== null`), 500))
    equal('which takes no clicks', await ui(stage, `document.querySelector('body > .tab') ? getComputedStyle(document.querySelector('body > .tab')).pointerEvents : 'none'`), 'none')
    equal('and isn\'t mistaken for a tab', await ui(stage, `document.querySelectorAll('#tabstrip .tab').length`), stage.order.length)
    check('and it goes away', await until(() => ui(stage, `document.querySelector('body > .tab') === null`), 3000)) // timers run slowly in a hidden window
    appearance.update({ autoHide: true })
    await until(() => ui(stage, `document.body.classList.contains('chrome-hidden')`))

    // A download
    const dlDir = path.join(profile, 'animated-downloads')
    fs.mkdirSync(dlDir, { recursive: true })
    const realDownloads = app.getPath('downloads')
    app.setPath('downloads', dlDir)
    const windowsBefore = BrowserWindow.getAllWindows().length
    const overlay = () => BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === stage.win)
    const landedBefore = await ui(stage, `document.getElementById('downloads-btn').classList.contains('bounce')`)
    equal('no download has arrived yet', landedBefore, false)
    three.webContents.downloadURL(`${base}/a-file.zip`)
    check('a download flies across the window', await until(() => overlay(), 2000))
    equal('in a window that can\'t take focus', overlay()?.isFocusable(), false)
    equal('or sit in the taskbar', windowsBefore + 1, BrowserWindow.getAllWindows().length)
    check('the button is there to catch it', await ui(stage, `!document.getElementById('downloads-btn').hidden`))
    check('and the toolbar comes down for it', stage.revealed)
    check('it lands on the button', await until(() => ui(stage, `document.getElementById('downloads-btn').classList.contains('bounce')`), 2500))
    check('and its window goes away', await until(() => !overlay(), 500))
    await wait(50)
    equal('nothing is left behind', BrowserWindow.getAllWindows().length, windowsBefore)

    reducedMotion = true
    await ui(stage, `document.getElementById('downloads-btn').classList.remove('bounce')`)
    three.webContents.downloadURL(`${base}/b-file.zip`)
    check('with Windows set to less motion, it just arrives', await until(() => ui(stage, `document.getElementById('downloads-btn').classList.contains('bounce')`), 1500))
    equal('without flying', overlay(), undefined)
    const quiet = stage.createTab({ url: `${base}/a-quiet` })
    await until(() => !quiet.webContents.isLoading())
    stage.closeTab(quiet.id)
    check('and a tab closes straight away', await until(() => quiet.webContents.isDestroyed(), 100))
    app.setPath('downloads', realDownloads)
    const downloads = require(path.join(REPO, 'src/main/downloads.js'))
    await until(() => downloads.listDownloads(false).every((d) => d.state !== 'progressing'), 3000)
    downloads.downloadAction('clear')

    stage.win.close()
    await until(() => !BrowserShell.all.has(stage))
    reducedMotion = true
  }

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
  await until(() => ui(shell, `!document.getElementById('drag-zones').hidden && document.querySelector('.drag-zone.over')?.dataset.zone === 'right'`), 1000)
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

  console.log('\nYouTube stopping partway through')
  {
    const sound = (() => {
      const samples = 8000 * 30
      const header = Buffer.alloc(44)
      header.write('RIFF', 0); header.writeUInt32LE(36 + samples, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16)
      header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24); header.writeUInt32LE(8000, 28)
      header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34); header.write('data', 36); header.writeUInt32LE(samples, 40)
      return Buffer.concat([header, Buffer.alloc(samples, 128)])
    })()
    const ses = shell.session
    ses.protocol.handle('https', (request) => {
      if (new URL(request.url).pathname === '/sound.wav') return new Response(sound, { headers: { 'content-type': 'audio/wav' } })
      return new Response('<!doctype html><title>Video</title><video class="html5-main-video" src="/sound.wav" autoplay muted></video><div id="box"></div>', { headers: { 'content-type': 'text/html' } })
    })
    const watch = shell.createTab({ url: 'https://www.youtube.com/watch?v=one&list=keep', active: false })
    const wc = watch.webContents
    const settled = () => until(() => !wc.isLoading() && wc.getURL(), 5000)
    const playing = () => until(() => wc.executeJavaScript(`document.querySelector('video').currentTime > 1.5`).catch(() => false), 6000)
    const failHere = () => wc.executeJavaScript(`(() => { document.querySelector('video')?.pause(); document.getElementById('box').innerHTML = '<div class="ytp-error-content-wrap-reason">Something went wrong</div>'; return 1 })()`)
    const reloaded = (before) => until(() => !wc.isLoading() && wc.getURL() !== before && /[?&]t=\d+s/.test(wc.getURL()), 5000)
    await settled()
    check('a video can play in the test page', await playing())
    await wc.executeJavaScript(`window.stillHere = true`)
    const firstUrl = wc.getURL()
    await failHere()
    check('an error partway through a video reloads it', await reloaded(firstUrl), wc.getURL())
    check('at the same point in the video', /[?&]t=[1-9]\d*s/.test(wc.getURL()), wc.getURL())
    check('keeping the rest of the address', wc.getURL().includes('v=one') && wc.getURL().includes('list=keep'), wc.getURL())
    check('it plays on', await playing())
    wc.executeJavaScript(`document.querySelector('video').currentTime = 2; 1`).catch(() => {})
    await wc.executeJavaScript(`window.stillHere = true`)
    await failHere()
    check('a second time is allowed', await until(() => wc.executeJavaScript(`!window.stillHere`).catch(() => false), 5000))
    await settled()
    check('and it plays again', await playing())
    await wc.executeJavaScript(`window.stillHere = true`)
    await failHere()
    await wait(2500)
    equal('but a third stops trying, and YouTube\'s message stays up', await wc.executeJavaScript(`window.stillHere === true && Boolean(document.querySelector('.ytp-error-content-wrap-reason'))`), true)

    const fresh = shell.createTab({ url: 'about:blank', active: false })
    const load2 = async (url) => {
      await fresh.webContents.loadURL(url).catch(() => {})
      await until(() => !fresh.webContents.isLoading(), 5000)
      await fresh.webContents.executeJavaScript(`window.stillHere = true`)
    }
    const stays = async (label, before) => {
      if (before) await before()
      await fresh.webContents.executeJavaScript(`(() => { document.getElementById('box').innerHTML = '<div class="ytp-error-content-wrap-reason">This video is private</div>'; document.querySelector('video')?.pause(); return 1 })()`)
      await wait(2300)
      equal(label, await fresh.webContents.executeJavaScript(`window.stillHere === true`), true)
    }
    await load2('https://www.youtube.com/watch?v=two')
    await fresh.webContents.executeJavaScript(`document.querySelector('video').removeAttribute('autoplay'); document.querySelector('video').pause(); 1`)
    await stays('a video that never played keeps its message')
    await load2('https://www.youtube.com/watch?v=three')
    await until(() => fresh.webContents.executeJavaScript(`document.querySelector('video').currentTime > 1.5`), 6000)
    await stays('text you\'re typing isn\'t reloaded away', () => fresh.webContents.executeJavaScript(`(() => { const t = document.createElement('textarea'); t.value = 'half a comment'; document.body.append(t); t.focus(); return 1 })()`))
    await load2('https://example.test/watch?v=four')
    await until(() => fresh.webContents.executeJavaScript(`document.querySelector('video').currentTime > 1.5`), 6000)
    await stays('other sites are left alone')
    shell.closeTab(fresh.id)
    shell.closeTab(watch.id)
    ses.protocol.unhandle('https')
    await wait(100)
  }

  console.log('\nSleeping tabs')
  {
    const sleepingTabs = require(path.join(REPO, 'src/main/sleeping-tabs.js'))
    const later = () => Date.now() + sleepingTabs.SLEEP_AFTER_MS + 1000
    const uniqueHost = (n) => `${base.replace('127.0.0.1', `sleep${n}.localhost`)}`
    const open = async (url) => {
      const tab = shell.createTab({ url, active: false })
      await until(() => !tab.webContents.isLoading(), 5000)
      await wait(150)
      return tab
    }
    check('it\'s on unless you turn it off', sleepingTabs.enabled())
    const home = shell.activeTab()
    const first = await open(`${uniqueHost(1)}/first`)
    first.navigate(`${uniqueHost(1)}/second`)
    await until(() => first.webContents.getURL().endsWith('/second'), 5000)
    await until(() => !first.webContents.isLoading(), 5000)
    equal('a tab you just left stays awake', await first.sleepIfUnused(), false)
    equal('a long-unused tab goes to sleep', await first.sleepIfUnused(later()), true)
    check('its page process is gone', await until(() => first.webContents.isCrashed(), 3000))
    await wait(150)
    equal('with no crash message', await ui(shell, `[...document.querySelectorAll('.prompt:not(.leaving) .prompt-title')].filter((t) => t.textContent.includes('stopped working')).length`), 0)
    check('the tab keeps its address', first.url.endsWith('/second'), first.url)
    equal('it looks asleep, not crashed', [first.state().sleeping, first.state().crashed], [true, false])
    check('the tab strip dims it', await until(() => ui(shell, `Boolean(document.querySelector('.tab[data-id="${first.id}"].sleeping'))`)))
    shell.selectTab(first.id)
    check('selecting it wakes it', await until(() => !first.webContents.isCrashed() && !first.webContents.isLoading() && first.webContents.getTitle().includes('/second'), 6000), first.webContents.getTitle())
    equal('and it isn\'t asleep any more', first.state().sleeping, false)
    check('back still goes back', first.webContents.navigationHistory.canGoBack())
    first.webContents.navigationHistory.goBack()
    check('to the page before', await until(() => first.webContents.getURL().endsWith('/first'), 5000), first.webContents.getURL())
    shell.selectTab(home.id)
    await wait(100)
    equal('a tab on screen never sleeps', await home.sleepIfUnused(later()), false)

    const typed = await open(`${uniqueHost(2)}/typed`)
    await typed.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', '<textarea id=t></textarea>'); document.getElementById('t').value = 'half a message'; 1`, true)
    equal('a tab with text typed in stays awake', await typed.sleepIfUnused(later()), false)
    const noisy = await open(`${uniqueHost(3)}/noisy`)
    const realAudible = noisy.webContents.isCurrentlyAudible
    noisy.webContents.isCurrentlyAudible = () => true
    equal('a tab playing sound stays awake', await noisy.sleepIfUnused(later()), false)
    noisy.webContents.isCurrentlyAudible = realAudible
    const store = require(path.join(REPO, 'src/main/store.js'))
    const chatty = await open(`${uniqueHost(4)}/chatty`)
    const chattyOrigin = new URL(chatty.url).origin
    const permissions = store.get('permissions')
    store.set('permissions', { ...permissions, [`${chattyOrigin} notifications`]: true })
    equal('a site allowed to notify you stays awake', await chatty.sleepIfUnused(later()), false)
    store.set('permissions', permissions)
    const twin = await open(`${uniqueHost(5)}/twin`)
    const realPid = twin.webContents.getOSProcessId
    twin.webContents.getOSProcessId = () => home.webContents.getOSProcessId()
    equal('a tab sharing its process with another stays awake', await twin.sleepIfUnused(later()), false)
    twin.webContents.getOSProcessId = realPid
    const lazy = shell.createTab({ url: `${uniqueHost(6)}/lazy`, active: false, lazy: true })
    equal('a restored tab that hasn\'t loaded has nothing to give back', await lazy.sleepIfUnused(later()), false)

    const paused = await open(`${uniqueHost(7)}/paused`)
    await paused.webContents.executeJavaScript(`(() => { const v = document.createElement('video'); document.body.append(v); Object.defineProperty(v, 'currentTime', { value: 90 }); return 1 })()`)
    equal('a tab holding your place in a video stays awake', await paused.sleepIfUnused(later()), false)
    const framed = await open(`${uniqueHost(8)}/framed`)
    await framed.webContents.executeJavaScript(`new Promise((done) => { const f = document.createElement('iframe'); f.onload = () => { f.contentDocument.body.innerHTML = '<textarea id=t></textarea>'; f.contentDocument.getElementById('t').value = 'half a message'; done(1) }; document.body.append(f) })`)
    await wait(100)
    equal('and so does one with text typed into a frame', await framed.sleepIfUnused(later()), false)
    const emptyFrame = await open(`${uniqueHost(13)}/empty-frame`)
    await emptyFrame.webContents.executeJavaScript(`new Promise((done) => { const f = document.createElement('iframe'); f.sandbox = ''; f.style.display = 'none'; f.onload = () => done(1); document.body.append(f) })`)
    await wait(100)
    equal('an empty hidden frame doesn\'t keep a tab awake', await emptyFrame.sleepIfUnused(later()), true)
    const blocker = require(path.join(REPO, 'src/main/blocker.js'))
    const submit = (tab, action) => tab.webContents.executeJavaScript(`(() => { const f = document.createElement('form'); f.method = 'post'; f.action = '${action}'; document.body.append(f); f.submit(); return 1 })()`)
    const formAnswer = await open(`${uniqueHost(9)}/form`)
    await submit(formAnswer, '/form-answer')
    await until(() => formAnswer.webContents.getURL().endsWith('/form-answer') && !formAnswer.webContents.isLoading(), 5000)
    check('the answer to a form is noticed', blocker.cameFromForm(formAnswer.webContents))
    equal('and stays awake, since reloading would need the form sent again', await formAnswer.sleepIfUnused(later()), false)
    const redirected = await open(`${uniqueHost(10)}/form`)
    await submit(redirected, '/form-then-redirect')
    await until(() => redirected.webContents.getURL().endsWith('/after-form') && !redirected.webContents.isLoading(), 5000)
    check('a form that sends you to a normal page doesn\'t count', !blocker.cameFromForm(redirected.webContents))
    equal('so that tab can sleep', await redirected.sleepIfUnused(later()), true)
    await until(() => redirected.webContents.isCrashed(), 3000)
    redirected.webContents.reload()
    check('reloading a sleeping tab some other way wakes it', await until(() => !redirected.webContents.isCrashed() && !redirected.webContents.isLoading(), 5000))
    equal('and it stops looking asleep', redirected.state().sleeping, false)

    const movable = await open(`${uniqueHost(11)}/movable`)
    equal('a tab about to move to a new window sleeps', await movable.sleepIfUnused(later()), true)
    await until(() => movable.webContents.isCrashed(), 3000)
    const elsewhere = shell.newWindow({ adoptTab: movable })
    check('moving it to a new window wakes it', await until(() => !movable.webContents.isCrashed() && !movable.webContents.isLoading() && movable.webContents.getTitle().includes('/movable'), 6000), movable.webContents.getTitle())
    elsewhere.win.close()
    await until(() => elsewhere.closed, 3000)
    const toClose = await open(`${uniqueHost(12)}/to-close`)
    equal('a sleeping tab', await toClose.sleepIfUnused(later()), true)
    await until(() => toClose.webContents.isCrashed(), 3000)
    shell.closeTab(toClose.id)
    check('can be closed', await until(() => !shell.tabs.has(toClose.id), 3000))
    for (const tab of [first, typed, noisy, chatty, twin, lazy, paused, framed, emptyFrame, formAnswer, redirected]) shell.closeTab(tab.id)
    await wait(100)

    menus.runAction(shell, 'toggle-sleep-tabs')
    equal('the ⋯ switch turns it off', sleepingTabs.enabled(), false)
    await until(() => ui(shell, `true`))
    menus.runAction(shell, 'toggle-sleep-tabs')
    equal('and back on', sleepingTabs.enabled(), true)
    check('the ⋯ panel has the switch', await ui(shell, `Boolean(document.getElementById('mp-sleep-tabs'))`))

    // Over the memory budget, tabs left alone for 5 minutes sleep too.
    const realMetrics = app.getAppMetrics
    const using = (mb) => { app.getAppMetrics = () => [{ memory: { privateBytes: mb * 1024 } }] }
    const minutes = (n) => n * 60_000
    const budgetMb = sleepingTabs.MEMORY_BUDGET_BYTES / 1048576
    const older = await open(`${uniqueHost(20)}/older`)
    const newer = await open(`${uniqueHost(21)}/newer`)
    const recent = await open(`${uniqueHost(22)}/recent`)
    const now = Date.now()
    older.lastSeen = now - minutes(9)
    newer.lastSeen = now - minutes(6)
    recent.lastSeen = now - minutes(2)
    using(budgetMb - 1)
    await sleepingTabs.check(now)
    equal('under budget, nothing sleeps before 30 minutes', [older.sleeping, newer.sleeping, recent.sleeping], [false, false, false])
    using(budgetMb + 1)
    await sleepingTabs.check(now)
    equal('over budget, the longest unused sleeps first', [older.sleeping, newer.sleeping, recent.sleeping], [true, false, false])
    await sleepingTabs.check(now)
    equal('then the next, one at a time', [older.sleeping, newer.sleeping, recent.sleeping], [true, true, false])
    await sleepingTabs.check(now)
    equal('but not one you used in the last 5 minutes', recent.sleeping, false)
    newer.lastSeen = now
    const quiet = await open(`${uniqueHost(23)}/quiet`)
    quiet.lastSeen = now - minutes(6)
    using(budgetMb - 1)
    await sleepingTabs.check(now)
    equal('back under budget, it stops', quiet.sleeping, false)
    using(budgetMb + 1)
    menus.runAction(shell, 'toggle-sleep-tabs')
    await sleepingTabs.check(now)
    equal('and the switch turns this off too', quiet.sleeping, false)
    menus.runAction(shell, 'toggle-sleep-tabs')
    const protectedTab = await open(`${uniqueHost(24)}/protected`)
    await protectedTab.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', '<textarea id=t></textarea>'); document.getElementById('t').value = 'half a message'; 1`, true)
    protectedTab.lastSeen = now - minutes(60)
    quiet.lastSeen = now
    await sleepingTabs.check(now)
    equal('text you\'ve typed still keeps a tab awake', protectedTab.sleeping, false)
    app.getAppMetrics = realMetrics
    check('the real count of memory is a positive number', require(path.join(REPO, 'src/main/sleeping-tabs.js')).MEMORY_BUDGET_BYTES > 0 && realMetrics.call(app).every((m) => m.memory.privateBytes > 0))
    for (const tab of [older, newer, recent, quiet, protectedTab]) shell.closeTab(tab.id)
    await wait(100)
  }

  console.log('\nEncrypted DNS')
  {
    const blocker = require(path.join(REPO, 'src/main/blocker.js'))
    const real = app.configureHostResolver
    const calls = []
    app.configureHostResolver = (options) => (calls.push(options), real.call(app, options))
    equal('it\'s on by default', blocker.getSettings().secureDns, true)
    blocker.set({ secureDns: false })
    equal('the switch turns it off', [blocker.getSettings().secureDns, calls.at(-1).secureDnsMode], [false, 'off'])
    blocker.set({ secureDns: true })
    equal('and back on, with a fallback', [blocker.getSettings().secureDns, calls.at(-1).secureDnsMode], [true, 'automatic'])
    check('no Google servers', calls.at(-1).secureDnsServers.length > 0 && !calls.at(-1).secureDnsServers.some((s) => /google|8\.8\.8\.8|dns\.google/.test(s)))
    app.configureHostResolver = real
    const page = shell.createTab({ url: 'glasswing://protection/' })
    await until(() => !page.webContents.isLoading())
    await until(() => page.webContents.executeJavaScript(`document.getElementById('secureDns').classList.contains('on')`, true), 3000)
    check('the Protection page shows it', await page.webContents.executeJavaScript(`document.getElementById('secureDns').classList.contains('on')`, true))
    await page.webContents.executeJavaScript(`document.getElementById('secureDns').click(); 1`, true)
    check('and can change it', await until(() => blocker.getSettings().secureDns === false))
    blocker.set({ secureDns: true })
    equal('turning it off keeps your other settings', [blocker.getSettings().ads, blocker.getSettings().trackers], [true, true])
    shell.closeTab(page.id)
  }

  console.log('\nPicture in Picture and screenshots')
  {
    const tab = shell.createTab({ url: `${base}/no-video` })
    await until(() => !tab.webContents.isLoading(), 5000)
    equal('with no video it says so', await tab.togglePictureInPicture(), 'none')
    check('the ⋯ panel has both', await ui(shell, `Boolean(document.querySelector('[data-action="picture-in-picture"]') && document.querySelector('[data-action="screenshot"]'))`))
    if (testWindowStates) {
      await tab.webContents.executeJavaScript(`(() => {
        const c = document.createElement('canvas'); c.width = 320; c.height = 180; c.getContext('2d').fillRect(0, 0, 320, 180)
        const v = document.createElement('video'); v.id = 'v'; v.muted = true; v.srcObject = c.captureStream(5); document.body.append(v); return v.play().then(() => 1)
      })()`, true)
      await wait(300)
      equal('a video pops out', await tab.togglePictureInPicture(), 'open')
      check('and the page knows', await tab.webContents.executeJavaScript(`Boolean(document.pictureInPictureElement)`, true))
      equal('the same keys put it back', await tab.togglePictureInPicture(), 'closed')
      const shots = path.join(profile, 'shots-test')
      fs.mkdirSync(shots)
      const realDownloads = app.getPath('downloads')
      app.setPath('downloads', shots)
      clipboard.clear()
      const file = await shell.saveScreenshot()
      check('a screenshot is saved', Boolean(file) && fs.statSync(file).size > 500 && file.endsWith('.png'), String(file))
      check('named after the site', Boolean(file) && path.basename(file).includes('127.0.0.1'), String(file))
      check('and copied', await clipboard.has('image/png'))
      const stamp = path.basename(file).match(/(\d{4})-(\d\d)-(\d\d) (\d\d)-/)
      equal('named with the time on your clock', Number(stamp?.[4]), new Date().getHours())
      const blockedFolder = path.join(shots, 'a-file-not-a-folder')
      fs.writeFileSync(blockedFolder, '')
      app.setPath('downloads', blockedFolder)
      equal('if it can\'t be saved, nothing breaks', await shell.saveScreenshot(), null)
      const repeats = []
      const realSave = shell.saveScreenshot
      shell.saveScreenshot = () => repeats.push('shot')
      const keys = require(path.join(REPO, 'src/main/shortcuts.js'))
      keys.handle(shell, { type: 'keyDown', key: 'S', control: true, shift: true, alt: false, meta: false, isAutoRepeat: false })
      keys.handle(shell, { type: 'keyDown', key: 'S', control: true, shift: true, alt: false, meta: false, isAutoRepeat: true })
      shell.saveScreenshot = realSave
      equal('holding the keys takes one screenshot', repeats.length, 1)
      app.setPath('downloads', realDownloads)
      fs.rmSync(shots, { recursive: true, force: true })
    }
    const dead = shell.createTab({ url: `${base}/dead`, active: false })
    await until(() => !dead.webContents.isLoading(), 5000)
    dead.webContents.forcefullyCrashRenderer()
    await until(() => dead.webContents.isCrashed(), 3000)
    equal('a crashed page says there\'s no video', await dead.togglePictureInPicture(), 'none')
    shell.closeTab(dead.id)
    shell.closeTab(tab.id)
    await wait(100)
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

  console.log('\nSurviving a crash')
  {
    const { safeStorage, session } = electron
    const savedStore = require(path.join(REPO, 'src/main/store.js'))
    const stateFile = path.join(profile, 'glasswing.json')
    const realSync = fs.fsyncSync
    let synced = 0
    fs.fsyncSync = (handle) => (synced++, realSync(handle))
    savedStore.set('crashTest', 'kept')
    savedStore.flush()
    fs.fsyncSync = realSync
    check('saved data reaches the disk before it replaces the old file', synced === 1, `synced ${synced} times`)
    equal('and the file is whole', JSON.parse(fs.readFileSync(stateFile, 'utf8')).crashTest, 'kept')
    check('with nothing left over', !fs.existsSync(`${stateFile}.tmp`))

    const { keepSessionCookiesSaved } = require(path.join(REPO, 'src/main/persistence.js'))
    const cookieFile = path.join(profile, 'session-cookies.bin')
    const savedCookies = () => {
      try {
        return JSON.parse(safeStorage.decryptString(fs.readFileSync(cookieFile))).map((c) => c.name)
      } catch {
        return []
      }
    }
    const jar = session.fromPartition('crash-test')
    keepSessionCookiesSaved(jar, 100)
    await jar.cookies.set({ url: 'https://crash-test.example/', name: 'login', value: 'yes' })
    check('a new session cookie is saved without quitting', await until(() => savedCookies().includes('login'), 3000), JSON.stringify(savedCookies()))
    await jar.cookies.set({ url: 'https://crash-test.example/', name: 'lasting', value: 'yes', expirationDate: Date.now() / 1000 + 1000 })
    await wait(300)
    check('cookies with a date look after themselves', !savedCookies().includes('lasting'))
    await jar.cookies.remove('https://crash-test.example/', 'login')
    check('signing out is saved too, so a crash can\'t undo it', await until(() => !savedCookies().includes('login'), 3000), JSON.stringify(savedCookies()))
    check('the cookie file isn\'t readable as plain text', !fs.readFileSync(cookieFile).includes('crash-test.example'))
    await jar.clearData()

    const saving = BrowserShell.keepSessionSaved(50)
    const savedUrls = () => (savedStore.get('session')?.windows ?? []).flatMap((w) => w.tabs.map((t) => t.url))
    const opened = shell.createTab({ url: `${base}/open-when-it-crashed`, active: false })
    await until(() => opened.webContents.getURL().endsWith('/open-when-it-crashed'), 5000)
    check('an open tab is saved without quitting', await until(() => savedUrls().some((u) => u.endsWith('/open-when-it-crashed')), 2000))
    shell.closeTab(opened.id)
    check('and a closed one stops being saved', await until(() => !savedUrls().some((u) => u.endsWith('/open-when-it-crashed')), 2000))
    const realSet = savedStore.set
    let sessionWrites = 0
    savedStore.set = (key, value) => (key === 'session' && sessionWrites++, realSet(key, value))
    await wait(300)
    savedStore.set = realSet
    equal('nothing changed, so nothing is written', sessionWrites, 0)
    const secret = BrowserShell.create({ private: true, urls: [`${base}/secret-tab`] })
    await until(() => secret.activeTab()?.webContents.getURL().endsWith('/secret-tab'), 5000)
    await wait(200)
    check('private tabs never are', !savedUrls().some((u) => u.endsWith('/secret-tab')))
    secret.win.close()
    await until(() => secret.closed, 3000)
    clearInterval(saving)
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

  console.log('\nClicking tabs')
  {
    const pair = BrowserShell.create({ urls: ['a', 'b', 'c', 'd'].map((n) => `${base}/white?${n}`), fullscreen: false })
    pair.win.setBounds({ x: -6000, y: -6000, width: 1600, height: 800 })
    showWithoutFocus.call(pair.win)
    await wait(600)
    const [first, second, third] = pair.order.map((id) => pair.tabs.get(id))
    pair.mustShowChrome = () => true // the toolbar stays down, because the real pointer isn't anywhere near it
    await wait(500)
    const { debugger: mouse } = pair.ui.webContents
    mouse.attach('1.3')
    const send = (type, x, y, extra = {}) => mouse.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra })
    const moveTo = (x, y) => mouse.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    const spotOn = (tab, along = 0.5) => ui(pair, `(() => { const r = document.querySelector('.tab[data-id="${tab.id}"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width * ${along}), y: Math.round(r.y + r.height / 2) } })()`)
    const dragging = () => ui(pair, `dragState !== null || document.querySelector('.tab.dragging, .tab.pulled-out') !== null || !document.getElementById('drag-zones').hidden`)
    const order = () => pair.order.join()
    pair.selectTab(first.id)
    await wait(150)
    const before = order()

    let at = await spotOn(second)
    await moveTo(at.x, at.y)
    await send('mousePressed', at.x, at.y, { clickCount: 1, buttons: 1 })
    await send('mouseMoved', at.x + 12, at.y + 3, { buttons: 1 })
    await send('mouseReleased', at.x + 12, at.y + 3, { clickCount: 1 })
    check('a quick click with a wobble selects the tab', await until(() => pair.activeId === second.id, 1000), String(pair.activeId))
    equal('and doesn\'t move it', order(), before)
    equal('or leave it being dragged', await dragging(), false)

    at = await spotOn(third)
    await moveTo(at.x, at.y)
    await send('mousePressed', at.x, at.y, { clickCount: 1, buttons: 1 })
    await send('mouseMoved', at.x + 2, at.y + 70, { buttons: 1 })
    await send('mouseReleased', at.x + 2, at.y + 70, { clickCount: 1 })
    check('a quick click flicked off the tab still selects it', await until(() => pair.activeId === third.id, 1000), String(pair.activeId))
    equal('with no new window', [BrowserShell.all.has(pair), pair.order.length], [true, 4])
    equal('and nothing being dragged', await dragging(), false)

    // A click that loses the keyboard to a page halfway through.
    pair.selectTab(first.id)
    await wait(150)
    at = await spotOn(second)
    await moveTo(at.x, at.y)
    await send('mousePressed', at.x, at.y, { clickCount: 1, buttons: 1 })
    await ui(pair, `window.dispatchEvent(new Event('blur'))`)
    await send('mouseReleased', at.x, at.y, { clickCount: 1 })
    check('a page taking the keyboard mid-click doesn\'t lose the click', await until(() => pair.activeId === second.id, 1000), String(pair.activeId))

    // A release that never arrived, then another click.
    pair.selectTab(first.id)
    await wait(150)
    at = await spotOn(second)
    await moveTo(at.x, at.y)
    await send('mousePressed', at.x, at.y, { clickCount: 1, buttons: 1 })
    await send('mouseReleased', at.x, at.y, { clickCount: 1 })
    await until(() => pair.activeId === second.id, 1000)
    await ui(pair, `document.querySelector('.tab[data-id="${third.id}"]').dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: ${at.x}, clientY: ${at.y}, bubbles: true }))`)
    await send('mousePressed', 2, 300, { clickCount: 1, buttons: 1 }) // the next press, somewhere else entirely
    await send('mouseReleased', 2, 300, { clickCount: 1 })
    await wait(250)
    at = await spotOn(first)
    await moveTo(at.x, at.y)
    await send('mousePressed', at.x, at.y, { clickCount: 1, buttons: 1 })
    await send('mouseReleased', at.x, at.y, { clickCount: 1 })
    check('a press that never finished doesn\'t spoil the next click', await until(() => pair.activeId === first.id, 1000), String(pair.activeId))
    equal('which isn\'t a drag either', await dragging(), false)
    equal('and nothing moved', order(), before)

    // Holding it is still a drag.
    at = await spotOn(third)
    await moveTo(at.x, at.y)
    await send('mousePressed', at.x, at.y, { clickCount: 1, buttons: 1 })
    await send('mouseMoved', at.x + 60, at.y, { buttons: 1 })
    check('holding the button and moving still drags', await until(() => ui(pair, `document.querySelector('.tab.dragging') !== null`), 1000))
    await send('mouseReleased', at.x + 60, at.y, { clickCount: 1 })
    await until(async () => !(await dragging()), 1000)

    // The X.
    const closeOf = (tab, code) => ui(pair, `(() => { const b = document.querySelector('.tab[data-id="${tab.id}"] .tab-close'); const s = getComputedStyle(b); return ${code} })()`)
    const showing = (tab) => closeOf(tab, `s.display !== 'none' && s.visibility === 'visible'`)
    pair.selectTab(first.id)
    await moveTo(0, 300) // the drag above left the pointer resting on the strip
    await wait(400)
    equal('with the pointer away, no X is showing', await showing(second), false)
    at = await spotOn(second, 0.1)
    const count = pair.order.length
    await Promise.all([
      moveTo(at.x, at.y),
      send('mousePressed', at.x, at.y, { clickCount: 1, buttons: 1 }),
      send('mouseReleased', at.x, at.y, { clickCount: 1 }),
    ])
    check('reaching a tab and clicking where its X would be selects the tab', await until(() => pair.activeId === second.id, 1000))
    equal('and doesn\'t close it', pair.order.length, count)
    pair.selectTab(first.id)
    await wait(150)
    await moveTo(0, 300)
    at = await spotOn(third, 0.1)
    await moveTo(at.x, at.y)
    check('after a moment it\'s there', await until(() => showing(third), 1000))
    await send('mousePressed', at.x, at.y, { clickCount: 1, buttons: 1 })
    await send('mouseReleased', at.x, at.y, { clickCount: 1 })
    check('and closes the tab', await until(() => !pair.tabs.has(third.id), 1000))

    // So many tabs that they're small.
    for (let i = 0; i < 40; i += 1) pair.createTab({ url: `${base}/white?many${i}`, active: false })
    pair.selectTab(first.id)
    await wait(400)
    const small = pair.tabs.get(pair.order[6])
    const width = await ui(pair, `document.querySelector('.tab[data-id="${small.id}"]').getBoundingClientRect().width`)
    check('with lots of tabs they get small', width < 60, String(width))
    await ui(pair, `document.querySelector('.tab[data-id="${small.id}"]').scrollIntoView({ inline: 'nearest' })`)
    await wait(100)
    at = await spotOn(small)
    await moveTo(at.x, at.y)
    await wait(300)
    equal('a small tab never shows the X', await showing(small), false)
    check('and keeps its icon', await ui(pair, `getComputedStyle(document.querySelector('.tab[data-id="${small.id}"] .tab-icon')).visibility === 'visible'`))
    const many = pair.order.length
    await send('mousePressed', at.x, at.y, { clickCount: 1, buttons: 1 })
    await send('mouseReleased', at.x, at.y, { clickCount: 1 })
    check('clicking a small tab selects it', await until(() => pair.activeId === small.id, 1000), String(pair.activeId))
    equal('every time', pair.order.length, many)
    mouse.detach()
    pair.win.destroy()
    await wait(200)
  }

  console.log('\nSaving a password')
  {
    const store = require(path.join(REPO, 'src/main/store.js'))
    const passwords = require(path.join(REPO, 'src/main/passwords.js'))
    const pair = BrowserShell.create({ urls: [`${base}/login-form`], fullscreen: false })
    pair.win.setBounds({ x: -6000, y: -6000, width: 1280, height: 800 })
    showWithoutFocus.call(pair.win)
    await wait(500)
    const login = pair.activeTab()
    await until(() => !login.webContents.isLoading())
    const SECRET = 'correct-horse-9'
    const signIn = (user, pass) => login.webContents.executeJavaScript(`(() => { document.getElementById('u').value = ${JSON.stringify(user)}; document.getElementById('p').value = ${JSON.stringify(pass)}; document.getElementById('f').requestSubmit() })()`)
    const field = (n, code) => ui(pair, `(() => { const i = document.querySelectorAll('.prompt:not(.leaving) .prompt-field input')[${n}]; return ${code} })()`)
    const press = (label) => ui(pair, `[...document.querySelectorAll('.prompt:not(.leaving) .btn')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`)
    const cardOpen = () => ui(pair, `document.querySelectorAll('.prompt:not(.leaving)').length`)
    login.webContents.focus()
    await wait(100)
    await signIn('sam.tester', SECRET)
    check('signing in offers to save', await until(async () => (await cardOpen()) === 1, 3000))
    equal('it shows the username', await field(0, 'i.value'), 'sam.tester')
    equal('the password is hidden', await field(1, 'i.type'), 'password')
    equal('with a dot for each character', await field(1, 'i.value.length'), SECRET.length)
    check('it doesn\'t take the keyboard from the page', login.webContents.isFocused())
    await shot(pair, 'password-save')
    await press('Show')
    equal('Show shows it', await field(1, 'i.type'), 'text')
    await press('Hide')
    equal('and Hide hides it again', await field(1, 'i.type'), 'password')
    await press('Not Now')
    await until(async () => (await cardOpen()) === 0)
    equal('Not Now saves nothing', (store.get('passwords') ?? []).length, 0)
    equal('and leaves nothing of it in the toolbar', await ui(pair, `document.documentElement.outerHTML.includes(${JSON.stringify(SECRET)})`), false)

    await signIn('sam.typo', 'another-one-22')
    await until(async () => (await cardOpen()) === 1, 3000)
    await field(0, `(i.value = 'sam.fixed', true)`)
    await press('Save')
    await until(async () => (await cardOpen()) === 0)
    const saved = store.get('passwords') ?? []
    equal('a username you fix is the one saved', saved.map((e) => e.username), ['sam.fixed'])
    check('the password is still encrypted', saved[0] && !String(saved[0].password).includes('another-one-22'))
    equal('the saved list knows how long it is', passwords.listForPage().saved[0].length, 'another-one-22'.length)
    check('and never gets the password', !JSON.stringify(passwords.listForPage()).includes('another-one-22'))
    await load(login, 'glasswing://passwords/')
    const listed = await until(() => login.webContents.executeJavaScript(`document.querySelector('#saved .desc')?.textContent.includes('•'.repeat(${'another-one-22'.length})) ?? false`), 3000)
    check('the Passwords page shows the username and a dot for each character', listed)
    equal('with no extra dots', await login.webContents.executeJavaScript(`document.querySelector('#saved .desc').textContent`), `sam.fixed  ·  ${'•'.repeat('another-one-22'.length)}`)
    store.set('passwords', [])
    pair.win.destroy()
    await wait(200)
  }

  console.log('\nTab groups')
  {
    const pair = BrowserShell.create({ urls: ['a', 'b', 'c', 'd'].map((n) => `${base}/white?${n}`), fullscreen: false })
    pair.win.setBounds({ x: -6000, y: -6000, width: 1600, height: 800 })
    showWithoutFocus.call(pair.win)
    await wait(600)
    const [a, b, c, d] = pair.order.map((id) => pair.tabs.get(id))
    const names = () => pair.order.map((id) => ({ [a.id]: 'a', [b.id]: 'b', [c.id]: 'c', [d.id]: 'd' })[id] ?? '?').join('')
    const strip = () => ui(pair, `[...document.getElementById('tabstrip').children].map((el) => el.classList.contains('tab-group') ? '[' + el.querySelector('.tab-group-name').textContent + ']' : (el.offsetWidth ? 't' : 'h')).join(' ')`)
    const menuClick = (label) => ui(pair, `[...document.querySelectorAll('.menu-item')].find((r) => r.textContent.includes(${JSON.stringify(label)})).click()`)
    const settle = () => wait(120)
    pair.selectTab(a.id)
    await settle()

    menus.tabContextMenu(pair, b.id, 200, 60)
    await settle()
    await menuClick('Add to New Group')
    check('a new group asks for a name', await until(() => ui(pair, `document.querySelectorAll('.prompt:not(.leaving) .prompt-field input').length === 1`), 2000))
    await ui(pair, `(() => { document.querySelector('.prompt:not(.leaving) .prompt-field input').value = 'Work'; [...document.querySelectorAll('.prompt:not(.leaving) .btn')].find((x) => x.textContent === 'Create').click() })()`)
    await until(() => pair.groups.size === 1, 2000)
    const group = [...pair.groups.values()][0]
    await settle()
    equal('its label sits just before its tab', await strip(), 't [Work] t t t')
    check('the group has a color', Boolean(group.color))
    check('its tab is marked with it', await ui(pair, `document.querySelector('.tab[data-id="${b.id}"]').dataset.groupColor === ${JSON.stringify(group.color)}`))
    await shot(pair, 'groups-open')

    pair.setTabGroup(d, group.id)
    await settle()
    equal('a group\'s tabs sit together', names(), 'abdc')
    equal('so the strip shows them that way', await strip(), 't [Work] t t t')

    const chip = (code) => ui(pair, `(() => { const el = document.querySelector('.tab-group'); return ${code} })()`)
    // A real press and release, through whatever's on top of the label, with the toolbar floating the way it normally does.
    pair.mustShowChrome = () => true // it stays down, because the real pointer isn't anywhere near it
    pair.setRevealed(true)
    await wait(500)
    const at = await chip(`(() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
    check('the label counts as part of the floating toolbar', (pair.floatingRects ?? []).some((r) => at.x >= r.x && at.x < r.x + r.width && at.y >= r.y && at.y < r.y + r.height), JSON.stringify(pair.floatingRects))
    const { debugger: labelInput } = pair.ui.webContents
    labelInput.attach('1.3')
    const pressLabel = async () => {
      // The tabs on either side change when it's clicked, so it may have moved.
      Object.assign(at, await chip(`(() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`))
      await labelInput.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', clickCount: 1 })
      await labelInput.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 })
    }
    await pressLabel()
    await settle()
    check('clicking the label hides its tabs', group.collapsed)
    equal('they\'re gone from the strip', await strip(), 't [Work] h h t')
    equal('and the label says how many', await chip(`el.querySelector('.tab-group-count').textContent`), '2')
    await shot(pair, 'groups-hidden')
    equal('the tab you\'re on is untouched', pair.activeId, a.id)
    pair.selectRelative(1)
    equal('moving through tabs passes over hidden ones', pair.activeId, c.id)
    pair.selectRelative(-1)
    equal('in both directions', pair.activeId, a.id)
    await pressLabel()
    await settle()
    labelInput.detach()
    check('clicking again shows them', !group.collapsed)
    equal('all back', await strip(), 't [Work] t t t')

    pair.selectTab(b.id)
    await settle()
    await chip('el.click()')
    await settle()
    check('hiding the group you\'re in moves you out of it', pair.activeTab().groupId !== group.id && group.collapsed, String(pair.activeId))
    check('and the address bar still has a tab to live in', await ui(pair, `Boolean(document.querySelector('.tab.active #address'))`))
    pair.selectTab(d.id)
    await settle()
    check('selecting a hidden tab shows its group', !group.collapsed)

    pair.selectTab(a.id)
    await settle()
    const child = pair.createTab({ url: `${base}/white?child`, active: false, openerId: b.id })
    equal('a link from a grouped tab joins the group', child.groupId, group.id)
    equal('and stays beside it', pair.order.indexOf(child.id), pair.order.indexOf(b.id) + 1)
    pair.closeTab(child.id)
    const copy = pair.duplicateTab(d.id)
    await settle()
    equal('so does a duplicate', pair.tabs.get(pair.order[pair.order.indexOf(d.id) + 1]).groupId, group.id)
    pair.closeTab(pair.order[pair.order.indexOf(d.id) + 1])
    await settle()

    // Dragging, with the same mouse events a person's hand would make.
    const drag = async (id, toX) => {
      await ui(pair, `(() => {
        const el = document.querySelector('.tab[data-id="${id}"]')
        const from = el.getBoundingClientRect()
        window.dragY = from.top + from.height / 2
        el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: from.left + 8, clientY: window.dragY, bubbles: true }))
      })()`)
      await wait(220) // held for long enough to be a drag and not a click
      await ui(pair, `(() => {
        const x = ${toX}
        window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: x, clientY: window.dragY }))
        window.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: window.dragY }))
      })()`)
    }
    const middleOf = (tab) => `(() => { const r = document.querySelector('.tab[data-id="${tab.id}"]').getBoundingClientRect(); return r.left + r.width * 0.25 })()`
    await drag(c.id, middleOf(d))
    await settle()
    equal('dragging a tab into a group adds it', c.groupId, group.id)
    equal('where it was dropped', names(), 'abcd')
    await drag(d.id, 'document.getElementById("tabstrip").getBoundingClientRect().right - 2')
    await settle()
    equal('dragging one out takes it out', d.groupId, null)
    equal('to where it was dropped', names(), 'abcd')
    equal('and the label stays with the others', await strip(), 't [Work] t t t')
    await drag(d.id, 'document.querySelector(".tab-group").getBoundingClientRect().left - 3')
    await settle()
    equal('dragging one before the group leaves it outside', [d.groupId, names()], [null, 'adbc'])
    moveCursor(640, 500)
    pair.selectTab(a.id)
    await settle()

    pair.splitWith(a.id, b.id, 'left')
    await settle()
    equal('split with a grouped tab, both sides share the group', a.groupId, group.id)
    pair.setTabGroup(b, null)
    equal('and they leave together', [a.groupId, b.groupId], [null, null])
    pair.unsplit(a.id)
    await settle()
    pair.setTabGroup(b, group.id)
    await settle()

    // What comes back after a restart.
    pair.selectTab(a.id)
    await settle()
    pair.toggleGroup(group.id)
    await settle()
    const session = JSON.parse(JSON.stringify(pair.serialize()))
    equal('the session keeps the group', session.groups.map((g) => [g.name, g.color, g.collapsed]), [['Work', group.color, true]])
    const back = BrowserShell.create({ tabs: session.tabs, activeIndex: session.active, groups: session.groups, splits: session.splits, fullscreen: false })
    back.win.setBounds({ x: -6000, y: -6000, width: 1600, height: 800 })
    showWithoutFocus.call(back.win)
    await wait(500)
    const backGroups = [...back.groups.values()]
    equal('and brings it back', backGroups.map((g) => [g.name, g.collapsed]), [['Work', true]])
    equal('with the same tabs in it', back.order.map((id) => back.tabs.get(id).groupId != null), session.tabs.map((t) => t.group === 0))
    check('and how long tabs were looked at', back.order.every((id, i) => back.tabs.get(id).lastSeen === session.tabs[i].lastSeen && back.tabs.get(id).seenMs === session.tabs[i].seenMs))
    back.win.destroy()
    await wait(100)
    const fromBefore = BrowserShell.create({ tabs: [{ url: `${base}/white?old` }, { url: `${base}/white?older` }], fullscreen: false })
    check('a session from before this can\'t call a tab brief', [...fromBefore.tabs.values()].every((tab) => tab.seenMs >= 60_000))
    fromBefore.win.destroy()
    await wait(100)

    pair.toggleGroup(group.id)
    pair.selectTab(a.id)
    await settle()
    const { order: beforeUngroup } = pair
    const count = beforeUngroup.length
    pair.ungroup(group.id)
    await settle()
    equal('ungrouping keeps every tab', pair.order.length, count)
    equal('and takes the label away', await ui(pair, `document.querySelectorAll('.tab-group').length`), 0)
    const second = pair.addGroup({ name: 'Later' })
    pair.setTabGroup(c, second.id)
    pair.setTabGroup(d, second.id)
    await settle()
    pair.closeGroup(second.id)
    await settle()
    equal('Close Group closes its tabs', [pair.tabs.has(c.id), pair.tabs.has(d.id), pair.groups.size], [false, false, 0])
    const last = pair.addGroup({ name: 'One' })
    pair.setTabGroup(b, last.id)
    pair.closeTab(b.id)
    await settle()
    equal('a group goes when its last tab does', pair.groups.size, 0)

    pair.win.destroy()
    await wait(200)
  }

  console.log('\nClean Up Tabs')
  {
    const cleanup = require(path.join(REPO, 'src/main/tab-cleanup.js'))
    const pair = BrowserShell.create({ urls: [`${base}/white?here`], fullscreen: false })
    pair.win.setBounds({ x: -6000, y: -6000, width: 1280, height: 800 })
    showWithoutFocus.call(pair.win)
    await wait(500)
    const here = pair.activeTab()
    const MIN = 60_000
    const DAY = 24 * 60 * MIN
    const now = Date.now()
    const open = async (name, { unused, seen, url = `${base}/white?${name}` }) => {
      const tab = pair.createTab({ url, active: false, lastSeen: now - unused, seenMs: seen })
      await until(() => !tab.webContents.isLoading(), 3000)
      return tab
    }
    const old = await open('old', { unused: 4 * DAY, seen: 10 * MIN })
    const brief = await open('brief', { unused: 20 * MIN, seen: 5000 })
    const blank = await open('blank', { unused: 1 * MIN, seen: 500, url: 'glasswing://newtab/' })
    const recentBrief = await open('recent-brief', { unused: 2 * MIN, seen: 5000 })
    const read = await open('read', { unused: 2 * DAY, seen: 10 * MIN })
    const neverSeen = await open('never-seen', { unused: 30 * MIN, seen: 0 })
    const oldGrouped = await open('old-grouped', { unused: 9 * DAY, seen: 10 * MIN })
    pair.setTabGroup(oldGrouped, pair.addGroup({ name: 'Keep' }).id)
    const typing = await open('typing', { unused: 9 * DAY, seen: 10 * MIN })
    await typing.webContents.executeJavaScript(`(() => { const i = document.createElement('input'); i.value = ''; document.body.append(i); i.value = 'half a message' })()`)
    const stuckInSplit = await open('split-partner', { unused: 9 * DAY, seen: 10 * MIN })
    pair.splitWith(here.id, stuckInSplit.id, 'left')
    await wait(150)

    const found = await cleanup.findTabs(pair)
    const foundTabs = found.map((f) => f.tab)
    check('finds a tab not used in days', foundTabs.includes(old))
    check('and one only looked at for a few seconds', foundTabs.includes(brief))
    check('and an empty new tab', foundTabs.includes(blank))
    check('oldest first', foundTabs[0] === old)
    const said = (tab) => found.find((f) => f.tab === tab)?.reason
    equal('it says why', said(old), 'Last used 4 days ago')
    equal('for each one', said(brief), 'Open for 5 seconds, 20 minutes ago')
    equal('even an empty one', said(blank), 'Empty new tab')
    const keep = (name, tab) => check(`keeps ${name}`, !foundTabs.includes(tab))
    keep('a brief visit from just now', recentBrief)
    keep('a tab you read and left for a couple of days', read)
    keep('a tab you opened but haven\'t looked at yet', neverSeen)
    keep('a tab you put in a group', oldGrouped)
    keep('a tab with something typed in it', typing)
    keep('both sides of the split on screen', stuckInSplit)
    keep('the tab you\'re on', here)

    const cardText = () => ui(pair, `document.querySelector('.prompt:not(.leaving)')?.textContent ?? ''`)
    const press = (label) => ui(pair, `[...document.querySelectorAll('.prompt:not(.leaving) .btn')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`)
    check('the ⋯ panel has it', await ui(pair, `Boolean(document.querySelector('[data-action="clean-up-tabs"]'))`))
    menus.runAction(pair, 'clean-up-tabs')
    check('it asks first', await until(async () => (await cardText()).includes('Clean up tabs?'), 2000))
    check('and lists them', (await cardText()).includes('Empty new tab') && (await cardText()).includes('Last used 4 days ago'))
    equal('nothing has closed yet', [pair.tabs.has(old.id), pair.tabs.has(brief.id), pair.tabs.has(blank.id)], [true, true, true])
    await shot(pair, 'clean-up')
    await press('Cancel')
    await until(async () => (await cardText()) === '')
    await wait(50)
    check('Cancel closes nothing', pair.tabs.has(old.id) && pair.tabs.has(brief.id) && pair.tabs.has(blank.id))

    const before = pair.closedTabs.length
    const running = cleanup.run(pair)
    await until(async () => (await cardText()).includes('Clean up tabs?'), 2000)
    await ui(pair, `document.querySelectorAll('.prompt:not(.leaving) .prompt-checklist-row input')[1].click()`) // spares the second
    const spared = foundTabs[1]
    await press('Close Tabs')
    equal('closes what was left ticked', await running, foundTabs.length - 1)
    check('and spares what you unticked', pair.tabs.has(spared.id))
    check('the others are gone', foundTabs.filter((t) => t !== spared).every((t) => !pair.tabs.has(t.id)))
    check('nothing else was touched', [here, recentBrief, read, neverSeen, oldGrouped, typing, stuckInSplit].every((t) => pair.tabs.has(t.id)))
    equal('tabs can come back afterward', pair.closedTabs.length - before, foundTabs.filter((t) => t !== spared && t !== blank).length)
    check('the page you were on stayed', pair.activeId === here.id)

    pair.closeTab(spared.id)
    await wait(100)
    equal('with nothing left to clean up, it says so', await cleanup.run(pair), 0)
    equal('and asks nothing', await cardText(), '')

    // The count itself.
    pair.unsplit(here.id)
    await wait(100)
    const counted = pair.createTab({ url: `${base}/white?counted`, active: false })
    equal('a tab starts with no time on screen', counted.totalSeenMs(), 0)
    pair.selectTab(counted.id)
    await wait(300)
    pair.selectTab(here.id)
    const time = counted.seenMs
    check('time on screen is counted', time >= 250 && time < 3000, String(time))
    check('and when you left it', Date.now() - counted.lastSeen < 1000)
    await wait(100)
    equal('it stops counting once you\'ve left', counted.totalSeenMs(), time)
    pair.win.destroy()
    await wait(200)
  }

  console.log('\nEmail codes')
  {
    const store = require(path.join(REPO, 'src/main/store.js'))
    const emailCode = require(path.join(REPO, 'src/main/email-code.js'))
    const pair = BrowserShell.create({ urls: [`${base}/white`], fullscreen: false })
    pair.win.setBounds({ x: -6000, y: -6000, width: 1280, height: 800 })
    showWithoutFocus.call(pair.win)
    await wait(400)
    const code = pair.activeTab()
    // On its own host, because your email counts as being on the same site as anything at its address.
    const pageAt = (name) => `${base.replace('127.0.0.1', 'localhost')}/email-code/${encodeURIComponent(name)}`
    const cardText = () => ui(pair, `[...document.querySelectorAll('.prompt:not(.leaving)')].map((p) => p.textContent).join('|')`)
    const press = (label) => ui(pair, `[...document.querySelector('.prompt:not(.leaving)').querySelectorAll('.btn')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`)
    const others = () => pair.order.map((id) => pair.tabs.get(id)).filter((t) => t !== code)

    // Every page gets its answer here, without opening anything. The card itself comes next.
    const seen = []
    const realOffer = emailCode.offer
    emailCode.offer = async () => seen.push(code.webContents.getURL())
    for (const name of Object.keys(emailCodePages)) {
      seen.length = 0
      await load(code, pageAt(name))
      const wanted = name.startsWith('yes')
      if (wanted) check(`noticed: ${name.slice(4)}`, await until(() => seen.length === 1, 3000), `seen ${seen.length}`)
      else {
        await wait(1100) // longer than it waits before looking
        equal(`left alone: ${name.slice(3)}`, seen.length, 0)
      }
    }
    // A single-page site moving to a page that wants a code.
    seen.length = 0
    await load(code, pageAt('no plain login'))
    await code.webContents.executeJavaScript(`document.querySelector('form').innerHTML = '<p>We sent a code to your email.</p><input name="otp">'`)
    check('a page that changes by itself gets noticed', await until(() => seen.length === 1, 3000))
    emailCode.offer = realOffer

    equal('nothing is saved until you choose', store.get('mailService'), undefined)
    await load(code, pageAt('yes one-time field'))
    check('the first time, it asks which email', await until(async () => (await cardText()).includes('Pick your email'), 3000), await cardText())
    check('and says the choice stays here', (await cardText()).includes('only saved on this computer'))
    check('the buttons all fit in the card', await ui(pair, `(() => { const card = document.querySelector('.prompt:not(.leaving)').getBoundingClientRect(); return [...document.querySelectorAll('.prompt:not(.leaving) .btn')].every((b) => { const r = b.getBoundingClientRect(); return r.left >= card.left && r.right <= card.right && r.bottom <= card.bottom }) })()`))
    await shot(pair, 'email-code-first')
    await press('Not now')
    await until(async () => (await cardText()) === '')
    equal('Not now opens nothing', others().length, 0)
    equal('and saves nothing', store.get('mailService'), undefined)
    await load(code, pageAt('yes masked address'))
    await wait(1100)
    equal('and that site isn\'t asked again for a while', await cardText(), '')

    emailCode.forgetAsked()
    await load(code, pageAt('yes one-time field'))
    await until(async () => (await cardText()).includes('Pick your email'), 3000)
    const offered = await cardText()
    check('every email is offered', ['Gmail', 'Outlook', 'Yahoo', 'iCloud', 'Proton'].every((n) => offered.includes(n)), offered)
    await press('Other…')
    check('Other asks for an address', await until(async () => (await cardText()).includes('Where’s your email'), 2000), await cardText())
    const type = (text) => ui(pair, `document.querySelector('.prompt:not(.leaving) .prompt-field input').value = ${JSON.stringify(text)}`)
    await type('not an address')
    await press('Open')
    check('a bad address is asked for again', await until(async () => (await cardText()).includes('doesn’t look like'), 2000), await cardText())
    await type('javascript:alert(1)')
    await press('Open')
    await wait(200)
    equal('and a script isn\'t an address', others().length, 0)
    await type(`${base}/white`)
    await press('Open')
    // 127.0.0.1 counts as an address with dots in it, which is all this needs.
    check('it opens next to the page', await until(() => others().length === 1 && code.split?.right === others()[0]?.id, 3000), JSON.stringify(code.split))
    const mail = others()[0]
    check('with the page on the left', code.split?.left === code.id)
    check('your email loads', await until(() => mail.webContents.getURL().endsWith('/white'), 3000), mail.webContents.getURL())
    equal('the choice is saved', store.get('mailService')?.url, `${base}/white`)
    check('the page stays the one in use', await until(() => pair.activeId === code.id, 2000), String(pair.activeId))
    check('and keeps the keyboard', await until(() => code.webContents.isFocused(), 2000))
    await shot(pair, 'email-code-open')

    emailCode.forgetAsked()
    await load(code, pageAt('yes masked address'))
    await wait(1100)
    equal('with your email already beside it, it says nothing', await cardText(), '')

    pair.unsplit(code.id)
    await wait(100)
    pair.selectTab(code.id)
    await load(code, pageAt('yes one-time field'))
    const name = store.get('mailService').name
    check('after that, it just offers your email', await until(async () => (await cardText()).includes(`Open ${name}`), 3000), await cardText())
    await press(`Open ${name}`)
    check('and uses the tab it\'s already in', await until(() => code.split?.right === mail.id, 2000) && others().length === 1, JSON.stringify(others().map((t) => t.url)))
    equal('it didn\'t reload that tab', mail.webContents.getURL(), `${base}/white`)

    // A third page: the split it was in has to give way, without closing anything.
    pair.unsplit(code.id)
    await wait(100)
    const third = pair.createTab({ url: `${base.replace('127.0.0.1', 'localhost')}/right-side`, active: false })
    pair.selectTab(code.id)
    pair.splitWith(code.id, third.id, 'left')
    await wait(100)
    emailCode.forgetAsked()
    await load(code, pageAt('yes masked address'))
    await until(async () => (await cardText()).includes(`Open ${name}`), 3000)
    await press(`Open ${name}`)
    check('a page already in a split swaps its partner for your email', await until(() => code.split?.right === mail.id, 2000))
    check('and the other page stays open', pair.tabs.has(third.id) && !third.split)
    pair.closeTab(third.id)
    pair.unsplit(code.id)
    await wait(100)

    pair.selectTab(code.id)
    emailCode.forgetAsked()
    await load(code, pageAt('yes one-time field'))
    await until(async () => (await cardText()).includes(`Open ${name}`), 3000)
    await load(code, `${base}/white`)
    check('the card goes away if you leave the page', await until(async () => (await cardText()) === '', 2000))

    menus.runAction(pair, 'toggle-email-codes')
    equal('the switch turns it off', pair.getState().emailCodes, false)
    emailCode.forgetAsked()
    await load(code, pageAt('yes one-time field'))
    await wait(1100)
    equal('and then nothing asks', await cardText(), '')
    menus.runAction(pair, 'toggle-email-codes')
    equal('and back on', pair.getState().emailCodes, true)
    check('the ⋯ panel has the switch', await ui(pair, `Boolean(document.getElementById('mp-email-codes'))`))

    check('what\'s saved is only the name and address of your email', Object.keys(store.get('mailService')).sort().join() === 'name,url')

    const priv = BrowserShell.create({ private: true, urls: [pageAt('yes one-time field')] })
    priv.win.setBounds({ x: -6000, y: -6000, width: 1280, height: 800 })
    showWithoutFocus.call(priv.win)
    await wait(2000)
    equal('private windows don\'t ask', await ui(priv, `document.querySelectorAll('.prompt:not(.leaving)').length`), 0)
    priv.win.destroy()
    pair.win.destroy()
    store.set('mailService', undefined)
    await wait(200)
  }

  console.log('\nThe + button')
  {
    const pair = BrowserShell.create({ urls: [`${base}/white`], fullscreen: false })
    pair.win.setBounds({ x: -6000, y: -6000, width: 1280, height: 800 })
    showWithoutFocus.call(pair.win)
    await wait(600)
    pair.activeTab().webContents.focus()
    await wait(100)
    check('a page has the keyboard to start with', pair.activeTab().webContents.isFocused())
    await ui(pair, `document.getElementById('new-tab').click()`)
    await until(() => pair.order.length === 2)
    const fresh = pair.activeTab()
    await until(() => !fresh.webContents.isLoading(), 3000)
    await wait(150)
    check('+ puts the keyboard in the address bar', pair.ui.webContents.isFocused())
    check('even after the new page has loaded', !fresh.webContents.isFocused())
    check('and it\'s ready to type in', await ui(pair, `document.activeElement.id === 'address-input'`))
    fresh.webContents.focus()
    await wait(100)
    check('after that, a page can have it back', fresh.webContents.isFocused())

    // Going back to tabs that are already open leaves the address bar alone, even an empty one.
    const [page] = pair.order.map((id) => pair.tabs.get(id))
    pair.mustShowChrome = () => true
    pair.setRevealed(true)
    await wait(400)
    const { debugger: mouse } = pair.ui.webContents
    mouse.attach('1.3')
    const clickTab = async (tab, times = 1) => {
      const at = await ui(pair, `(() => { const r = document.querySelector('.tab[data-id="${tab.id}"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
      for (let n = 1; n <= times; n++) {
        await mouse.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: n, buttons: 1 })
        await mouse.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: n })
        await wait(n < times ? 80 : 400)
      }
    }
    const typing = () => ui(pair, `document.activeElement.id === 'address-input' && document.querySelector('#address').classList.contains('editing')`)
    await clickTab(page)
    await wait(600) // past a double-click
    equal('clicking an open tab selects it', pair.activeId, page.id)
    await clickTab(fresh)
    await wait(600)
    equal('clicking back to the empty tab selects it', pair.activeId, fresh.id)
    equal('but doesn\'t start typing in the address bar', await typing(), false)
    await clickTab(fresh)
    equal('clicking the tab you\'re on doesn\'t either', await typing(), false)
    await wait(600)
    await clickTab(fresh, 2)
    check('double-clicking it does', await typing())
    mouse.detach()
    pair.win.destroy()
    await wait(200)
  }

  console.log('\nGraphics acceleration')
  {
    const pair = BrowserShell.create({ urls: [`${base}/white`], fullscreen: false })
    pair.win.setBounds({ x: -6000, y: -6000, width: 1280, height: 800 })
    showWithoutFocus.call(pair.win)
    await wait(600)
    const card = () => ui(pair, `document.querySelector('.prompt:not(.leaving)')?.textContent ?? ''`)
    const relaunch = electron.app.relaunch
    let relaunched = 0
    electron.app.relaunch = () => (relaunched += 1)
    equal('it\'s on to start with', pair.getState().graphics, true)
    check('the ⋯ panel has the switch', await ui(pair, `Boolean(document.getElementById('mp-graphics'))`))
    // These tests run without the graphics card, so turning it off matches how it's running and
    // turning it back on is the change that takes a restart.
    equal('(the tests run without the graphics card)', electron.app.isHardwareAccelerationEnabled(), false)
    menus.runAction(pair, 'toggle-graphics')
    equal('the switch turns it off', [pair.getState().graphics, store.get('graphicsAcceleration')], [false, false])
    await wait(400)
    equal('with nothing to restart for, it doesn\'t ask', await card(), '')
    menus.runAction(pair, 'toggle-graphics')
    equal('switching it back on', [pair.getState().graphics, store.get('graphicsAcceleration')], [true, true])
    check('offers to restart', await until(async () => (await card()).includes('Restart Glasswing'), 2000))
    const press = (label) => ui(pair, `[...document.querySelectorAll('.prompt:not(.leaving) .btn')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`)
    await press('Later')
    check('Later puts it away', await until(async () => (await card()) === '', 2000))
    equal('and doesn\'t restart anything', relaunched, 0)
    menus.runAction(pair, 'toggle-graphics')
    menus.runAction(pair, 'toggle-graphics')
    check('Restart Glasswing does', await until(async () => (await card()).includes('Restart Glasswing'), 2000))
    const quit = electron.app.quit
    let quits = 0
    electron.app.quit = () => (quits += 1)
    await press('Restart Glasswing')
    check('restarting', await until(() => relaunched === 1 && quits === 1, 2000), `${relaunched} ${quits}`)
    electron.app.quit = quit
    store.set('graphicsAcceleration', undefined)
    electron.app.relaunch = relaunch
    pair.win.destroy()
    await wait(200)
  }

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
}, 300_000)

require(path.join(REPO, 'src/main/index.js'))
