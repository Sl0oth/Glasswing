// Tests the first launch: the setup window, importing from other browsers, and that it only happens
// once. Everything is hidden and throwaway. The "other browsers" are fake profiles built here, in
// the same files and formats the real ones use.
//
//   npx electron test/first-run.js              the two launches, in separate processes
//   npx electron test/first-run.js --reopen     used by the above for the second launch
const { app, BrowserWindow, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')

const REPO = path.join(__dirname, '..')
const secondLaunch = process.argv.includes('--reopen')
const rootArg = process.argv.find((a) => a.startsWith('--root='))?.slice(7)
const root = rootArg ?? fs.mkdtempSync(path.join(os.tmpdir(), 'glasswing-firstrun-'))
const profile = path.join(root, 'profile')
const fakeAppData = path.join(root, 'local')
const shotsDir = process.argv.find((a) => a.startsWith('--shots='))?.slice(8)

fs.mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
process.env.LOCALAPPDATA = fakeAppData
process.env.GLASSWING_SKIP_BLOCKLIST_DOWNLOAD = '1'

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
if (!shotsDir) app.disableHardwareAcceleration()
BrowserWindow.prototype.focus = () => {}
if (!shotsDir) {
  BrowserWindow.prototype.show = () => {}
  BrowserWindow.prototype.showInactive = () => {}
  BrowserWindow.prototype.isVisible = () => true
}

const failures = []
const errors = []
let checks = 0
const check = (name, ok, detail = '') => {
  checks += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures.push(name)
}
const equal = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`)
process.on('uncaughtException', (err) => errors.push(`main: ${err.stack}`))
process.on('unhandledRejection', (err) => errors.push(`main (promise): ${err?.stack ?? err}`))

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await fn()) return true
    await wait(40)
  }
  return false
}

// ── Fake browsers ────────────────────────────────────────────────────────

const CHROMIUM_EPOCH_OFFSET_MS = 11_644_473_600_000
const chromiumTime = (ms) => (ms + CHROMIUM_EPOCH_OFFSET_MS) * 1000
const bookmark = (name, url) => ({ type: 'url', name, url })

function makeProfile(dir, { bookmarks, history = [], preferences = {}, keywords = [] }) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'Bookmarks'), JSON.stringify({ version: 1, roots: bookmarks }))
  fs.writeFileSync(path.join(dir, 'Preferences'), JSON.stringify(preferences))
  const db = new DatabaseSync(path.join(dir, 'History'))
  db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)')
  const add = db.prepare('INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, 0, ?, ?)')
  for (const h of history) add.run(h.url, h.title, h.visits, chromiumTime(h.time), h.hidden ?? 0)
  db.close()
  const web = new DatabaseSync(path.join(dir, 'Web Data'))
  web.exec('CREATE TABLE keywords (id INTEGER PRIMARY KEY, short_name TEXT, url TEXT, sync_guid TEXT)')
  const addKeyword = web.prepare('INSERT INTO keywords (short_name, url, sync_guid) VALUES (?, ?, ?)')
  for (const k of keywords) addKeyword.run(k.name, k.url, k.guid)
  web.close()
}

function makeFakeBrowsers() {
  const now = Date.now()
  const chrome = path.join(fakeAppData, 'Google', 'Chrome', 'User Data')
  fs.mkdirSync(chrome, { recursive: true })
  fs.writeFileSync(path.join(chrome, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 1', info_cache: { Default: { name: 'Personal', active_time: 100 }, 'Profile 1': { name: 'School', active_time: 200 } } } }))
  makeProfile(path.join(chrome, 'Default'), {
    bookmarks: {
      bookmark_bar: {
        children: [
          bookmark('On the bar', 'https://bar.example/'),
          { type: 'folder', name: 'Folder', children: [bookmark('In a folder', 'https://folder.example/')] },
          bookmark('A script, not a page', 'javascript:alert(1)'),
          bookmark('', 'https://untitled.example/'),
        ],
      },
      other: { children: [bookmark('Other bookmark', 'https://other.example/')] },
      synced: { children: [bookmark('Other bookmark again', 'https://other.example/')] },
    },
    history: [
      { url: 'https://visited.example/page?q=1', title: 'Visited “quoted” page', visits: 7, time: now - 3_600_000 },
      { url: 'https://hidden.example/', title: 'Hidden', visits: 1, time: now, hidden: 1 },
      { url: 'chrome://settings/', title: 'Not a website', visits: 9, time: now },
    ],
    preferences: { bookmark_bar: { show_on_all_tabs: false }, default_search_provider: { guid: 'guid-bing' } },
    keywords: [{ name: 'Bing', url: 'https://www.bing.com/search?q={searchTerms}', guid: 'guid-bing' }],
  })
  makeProfile(path.join(chrome, 'Profile 1'), {
    bookmarks: { bookmark_bar: { children: [bookmark('School site', 'https://school.example/')] } },
    history: [],
    preferences: { default_search_provider_data: { template_url_data: { url: '{google:baseURL}search?q={searchTerms}' } } },
  })

  // Many bookmarks, and no Local State: profiles still get found.
  const brave = path.join(fakeAppData, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default')
  makeProfile(brave, {
    bookmarks: { bookmark_bar: { children: Array.from({ length: 130 }, (_, i) => bookmark(`Site ${i}`, `https://site${i}.example/`)) } },
    history: [{ url: 'https://brave-only.example/', title: 'Brave page', visits: 1, time: now }],
    preferences: { bookmark_bar: { show_on_all_tabs: true } },
  })

  // Damaged files shouldn't stop anything.
  const edge = path.join(fakeAppData, 'Microsoft', 'Edge', 'User Data', 'Default')
  fs.mkdirSync(edge, { recursive: true })
  fs.writeFileSync(path.join(edge, 'Bookmarks'), '{ not json')
  fs.writeFileSync(path.join(edge, 'Preferences'), '{ also not json')
  fs.writeFileSync(path.join(edge, 'History'), 'this is not a database')
}

// ── First launch ─────────────────────────────────────────────────────────

async function firstLaunch() {
  makeFakeBrowsers()
  const { BrowserShell } = require(path.join(REPO, 'src/main/shell.js'))
  const store = require(path.join(REPO, 'src/main/store.js'))
  const favorites = require(path.join(REPO, 'src/main/favorites.js'))
  const history = require(path.join(REPO, 'src/main/history.js'))
  const appearance = require(path.join(REPO, 'src/main/appearance.js'))
  const blocker = require(path.join(REPO, 'src/main/blocker.js'))
  const search = require(path.join(REPO, 'src/main/search.js'))
  const updater = require(path.join(REPO, 'src/main/updater.js'))
  const { searchUrl } = require(path.join(REPO, 'src/main/url.js'))

  console.log('\nOpening')
  check('a window opens', await until(() => BrowserWindow.getAllWindows().length > 0, 15000))
  const win = BrowserWindow.getAllWindows()[0]
  await until(() => !win.webContents.isLoading())
  const page = (code) => win.webContents.executeJavaScript(code, true)
  win.webContents.on('console-message', (d) => {
    if (d.level === 'error' || d.level === 'warning') errors.push(`setup page: ${d.message}`)
  })
  check('its page loads', await until(() => page(`document.querySelector('section.current')?.dataset.step === 'welcome'`).catch(() => false)))
  equal('no browser window yet', BrowserShell.all.size, 0)
  equal('its title', await page(`document.querySelector('h1').textContent`), 'Welcome to Glasswing')
  check('the logo shows', await page(`document.getElementById('logo').complete && document.getElementById('logo').naturalWidth > 0`))
  equal('nothing is marked as done', store.get('onboarded'), undefined)

  const step = () => page(`document.querySelector('section.current').dataset.step`)
  const next = () => page(`document.getElementById('next').click()`)
  const label = () => page(`document.getElementById('next').textContent`)
  const shot = async (name) => {
    if (!shotsDir) return
    fs.mkdirSync(shotsDir, { recursive: true })
    await wait(350)
    const image = await win.webContents.capturePage()
    fs.writeFileSync(path.join(shotsDir, `${name}.png`), image.toPNG())
  }
  await shot('1-welcome')

  console.log('\nImport step')
  await next()
  equal('import comes next', await step(), 'import')
  const rows = await page(`[...document.querySelectorAll('#browser-list .option')].map((r) => ({ name: r.querySelector('b').textContent, detail: r.querySelector('small').textContent, picked: r.querySelector('input').checked, profiles: r.querySelector('select') ? r.querySelector('select').options.length : 1 }))`)
  equal('all three browsers are found', rows.map((r) => r.name), ['Chrome', 'Brave', 'Edge'])
  equal('Chrome\'s two profiles are offered', rows[0].profiles, 2)
  equal('the profile last used is shown first, not the biggest', rows[0].detail, '1 bookmark')
  equal('the browser used most recently is picked, not the biggest', rows.map((r) => r.picked), [true, false, false])
  equal('and that profile is selected', await page(`document.querySelector('#browser-list select').value`), 'Profile 1')
  await page(`(() => { const s = document.querySelector('#browser-list select'); s.value = 'Default'; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  equal('choosing another profile updates its counts', (await page(`document.querySelector('#browser-list small').textContent`)), '4 bookmarks · 1 history item')
  equal('a damaged profile just has nothing to offer', rows[2].detail, 'Nothing to bring over yet')
  equal('it offers to import', await label(), 'Import')
  check('and to skip', await page(`!document.getElementById('skip').hidden`))
  await shot('2-import')

  await page(`document.getElementById('skip').click()`)
  equal('skipping moves on', await step(), 'look')
  await page(`document.getElementById('back').click()`)
  equal('and back works', await step(), 'import')

  // Unticking everything turns the button into Continue.
  await page(`['bookmarks','history','settings'].forEach((p) => document.getElementById('part-' + p).click())`)
  equal('nothing ticked means nothing to import', await label(), 'Continue')
  await page(`['bookmarks','history','settings'].forEach((p) => document.getElementById('part-' + p).click())`)

  await page(`(() => { const r = document.querySelector('input[name="browser"][value="chrome"]'); r.click(); })()`)
  await next()
  check('importing finishes', await until(() => page(`!document.getElementById('import-result').hidden`)))
  const summary = await page(`document.getElementById('import-result').textContent`)
  check('and says what it did', /4 favorites added/.test(summary) && /1 history item/.test(summary) && /Bing/.test(summary), summary)
  equal('it stays to show the result, then continues', [await step(), await label()], ['import', 'Continue'])
  await shot('3-imported')

  equal('bookmarks became favorites, in order, replacing the starter ones', favorites.list().map((f) => f.url), ['https://bar.example/', 'https://untitled.example/', 'https://folder.example/', 'https://other.example/'])
  const found = history.query('visited.example').results[0]
  equal('history came across with its title', found?.title, 'Visited “quoted” page')
  const listed = history.list({ search: 'visited.example' }).items[0]
  equal('with its visit count', listed?.visits, 7)
  check('with the right date', Math.abs(listed?.lastVisit - (Date.now() - 3_600_000)) < 120_000, String(listed?.lastVisit))
  equal('hidden and internal pages stay out', [history.query('hidden.example').results.length, history.query('settings').results.length], [0, 0])
  equal('the search engine came across', search.current().id, 'bing')
  equal('so did the favorites bar setting', appearance.get().favoritesBar, false)
  check('and searching uses it', searchUrl('a b').startsWith('https://www.bing.com/search?q=a%20b'), searchUrl('a b'))

  console.log('\nImporting more')
  const beforeEmpty = favorites.list().length
  await page(`window.setup.import('edge', 'Default', { bookmarks: true })`)
  equal('a profile with no bookmarks leaves favorites alone', favorites.list().length, beforeEmpty)
  const again = await page(`window.setup.import('chrome', 'Default', { bookmarks: true, history: true, settings: false })`)
  equal('a repeat adds no duplicate favorites', [again.favorites, favorites.list().length], [0, 4])
  const school = await page(`window.setup.import('chrome', 'Profile 1', { bookmarks: true, history: false, settings: true })`)
  equal('another profile adds to the list', favorites.list().at(-1).url, 'https://school.example/')
  equal('Chromium\'s built-in Google address is understood', search.current().id, 'google')
  equal('a part that wasn\'t asked for stays out', school.history, 0)
  const many = await page(`window.setup.import('brave', 'Default', { bookmarks: true, history: false, settings: false })`)
  equal('favorites stop at the limit', favorites.list().length, 100)
  equal('what doesn\'t fit is counted', [many.favorites + 5, many.moreBookmarks], [100, 35])
  equal('and still comes up as you type', history.query('site129.example').results[0]?.url, 'https://site129.example/')
  const damaged = await page(`window.setup.import('edge', 'Default', { bookmarks: true, history: true, settings: true })`)
  equal('damaged files don\'t fail', [damaged.ok, damaged.favorites, damaged.history], [true, 0, 0])
  const missing = await page(`window.setup.import('chrome', '..\\\\..\\\\elsewhere', { bookmarks: true })`)
  equal('a path outside the browser is refused', missing.ok, false)

  console.log('\nLook')
  await next()
  equal('look comes next', await step(), 'look')
  const swatches = await page(`document.querySelectorAll('.preset').length`)
  equal('every theme is offered', swatches, appearance.PRESETS.length)
  await page(`document.querySelector('.preset[data-id="ocean"]').click()`)
  check('picking a theme saves it', await until(() => appearance.get().theme === 'ocean'))
  equal('and shows it here', await page(`getComputedStyle(document.documentElement).getPropertyValue('--c1').trim()`), appearance.PRESETS.find((p) => p.id === 'ocean').colors[0])
  await page(`document.querySelector('.accent[data-color="#30d158"]').click()`)
  check('picking an accent saves it', await until(() => appearance.get().accent === '#30d158'))
  await page(`document.querySelector('#material button[data-value="mica"]').click()`)
  check('picking a glass saves it', await until(() => appearance.get().material === 'mica'))
  await page(`document.querySelector('#material button[data-value="acrylic"]').click()`)
  await until(() => appearance.get().material === 'acrylic')
  await page(`(() => { const r = document.getElementById('tint-range'); r.value = 0.8; r.dispatchEvent(new Event('input')) })()`)
  check('the tint saves', await until(() => appearance.get().tint === 0.8))
  await shot('4-look')

  console.log('\nBrowsing')
  await next()
  equal('browsing comes next', await step(), 'browsing')
  equal('the imported engine is highlighted', await page(`document.querySelector('#engines .on').dataset.id`), 'bing')
  await page(`document.querySelector('#engines button[data-id="brave"]').click()`)
  check('the engine can be changed', await until(() => search.current().id === 'brave'))
  equal('the favorites bar shows what was imported', await page(`document.getElementById('favorites-bar').checked`), appearance.get().favoritesBar)
  await page(`document.getElementById('fullscreen').click()`)
  check('switches save', await until(() => appearance.get().fullscreen === false))
  await page(`document.getElementById('favorites-bar').click()`)
  await until(() => appearance.get().favoritesBar === true)
  await page(`document.getElementById('ads').click()`)
  check('protection can be changed', await until(() => blocker.getSettings().ads === false))
  await page(`document.getElementById('ads').click()`)
  await until(() => blocker.getSettings().ads === true)
  await shot('5-browsing')
  const overflow = await page(`(() => { const m = document.querySelector('main'); const out = []; const now = document.querySelector('section.current'); const result = document.getElementById('import-result'); for (const s of document.querySelectorAll('section')) { now.classList.remove('current'); s.classList.add('current'); if (s.scrollHeight > m.clientHeight) out.push(s.dataset.step + ' ' + s.scrollHeight + '>' + m.clientHeight); s.classList.remove('current'); now.classList.add('current') } return out })()`)
  equal('every step fits the window, even with an import result showing', overflow, [])

  console.log('\nUpdates and finishing')
  await next()
  equal('updates comes last', await step(), 'updates')
  equal('downloading for you is the default', await page(`document.querySelector('input[name="updates"]:checked').value`), 'auto')
  await page(`document.querySelector('input[name="updates"][value="ask"]').click()`)
  check('it can ask instead', await until(() => updater.getMode() === 'ask'))
  equal('the last button starts the browser', await label(), 'Start Browsing')
  await shot('6-updates')
  await next()

  check('the browser opens when it\'s finished', await until(() => BrowserShell.all.size === 1, 8000))
  check('the setup window is gone', await until(() => win.isDestroyed()))
  equal('it\'s marked as done', store.get('onboarded'), true)
  const shell = [...BrowserShell.all][0]
  await until(() => !shell.ui.webContents.isLoading())
  await wait(300)
  const ui = (code) => shell.ui.webContents.executeJavaScript(code, true)
  check('the toolbar knows the engine', await until(() => ui(`document.getElementById('address-text').textContent === 'Search Brave Search or enter website name'`)), await ui(`document.getElementById('address-text').textContent`))
  await until(() => !shell.activeTab().webContents.isLoading())
  await wait(200)
  const tabPage = shell.activeTab().webContents
  check('the new tab page knows too', await until(() => tabPage.executeJavaScript(`document.getElementById('q').placeholder === 'Search with Brave Search'`)))
  check('the favorites bar shows the imports', await until(() => ui(`document.getElementById('favorites')?.textContent.includes('On the bar') || document.getElementById('favbar')?.textContent.includes('On the bar') || document.body.textContent.includes('On the bar')`)))

  console.log('\nFrom the menu afterwards')
  const setup = require(path.join(REPO, 'src/main/setup.js'))
  const menus = require(path.join(REPO, 'src/main/menus.js'))
  menus.runAction(shell, 'setup')
  check('it can be reopened', await until(() => BrowserWindow.getAllWindows().some((w) => w !== shell.win && w.getTitle().includes('Welcome'))))
  const reopened = BrowserWindow.getAllWindows().find((w) => w !== shell.win && w.getTitle().includes('Welcome'))
  await until(() => !reopened.webContents.isLoading())
  check('and starts at the import step', await until(() => reopened.webContents.executeJavaScript(`document.querySelector('section.current')?.dataset.step === 'import'`).catch(() => false)))
  setup.open()
  await wait(200)
  equal('asking twice doesn\'t open two', BrowserWindow.getAllWindows().filter((w) => w !== shell.win && w.getTitle().includes('Welcome')).length, 1)
  reopened.close()
  check('closing that doesn\'t quit the browser', await until(() => reopened.isDestroyed()))
  equal('the browser\'s still there', BrowserShell.all.size, 1)
  menus.runAction(shell, 'check-updates')
  await wait(200)
  check('checking for updates from source says it can\'t', await until(() => ui(`document.getElementById('prompts').textContent.includes('running from source')`)))
  await ui(`document.querySelector('#prompts button').click()`)

  store.flush()
  await wait(100)
  app.removeAllListeners('window-all-closed')
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.releaseSingleInstanceLock()
}

// ── Second launch ────────────────────────────────────────────────────────

async function reopenLaunch() {
  const { BrowserShell } = require(path.join(REPO, 'src/main/shell.js'))
  const favorites = require(path.join(REPO, 'src/main/favorites.js'))
  const search = require(path.join(REPO, 'src/main/search.js'))
  const updater = require(path.join(REPO, 'src/main/updater.js'))
  const appearance = require(path.join(REPO, 'src/main/appearance.js'))
  console.log('\nThe next launch')
  check('the browser opens', await until(() => BrowserShell.all.size === 1, 15000))
  await wait(500)
  const titles = BrowserWindow.getAllWindows().map((w) => w.getTitle())
  check('with no setup window', !titles.some((t) => t.includes('Welcome')), titles.join(', '))
  equal('the choices were kept', [search.current().id, updater.getMode(), appearance.get().theme, appearance.get().accent, appearance.get().fullscreen], ['brave', 'ask', 'ocean', '#30d158', false])
  check('and the imports', favorites.list().some((f) => f.url === 'https://bar.example/'))
  app.removeAllListeners('window-all-closed')
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
}

app.whenReady().then(async () => {
  try {
    if (secondLaunch) {
      await reopenLaunch()
    } else {
      await firstLaunch()
      if (!shotsDir) {
        const result = spawnSync(process.execPath, [__filename, '--reopen', `--root=${root}`], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
        console.log(result.stdout)
        if (result.status !== 0) failures.push('the second launch')
      }
    }
  } catch (err) {
    errors.push(`test: ${err.stack}`)
  }
  for (const e of errors) console.log(` ERROR ${e}`)
  console.log(`${checks - failures.length}/${checks} checks passed, ${errors.length} errors logged`)
  if (!secondLaunch) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {}
  }
  app.exit(failures.length || errors.length ? 1 : 0)
})

setTimeout(() => {
  console.log('TIMED OUT')
  app.exit(1)
}, 120000)

require(path.join(REPO, 'src/main/index.js'))
