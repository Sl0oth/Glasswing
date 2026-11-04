// Built-in ad and tracker blocking, using the same filter lists as other blockers (EasyList,
// EasyPrivacy and friends) through Ghostery's engine.
//
// There are two engines: ads only, and ads plus trackers. "Trackers only" is whatever the combined
// engine would block that the ads engine wouldn't. That's also how each block gets counted.
const { app, ipcMain } = require('electron')
const { ElectronBlocker, Request } = require('@ghostery/adblocker-electron')
const { Worker } = require('node:worker_threads')
const fs = require('node:fs')
const path = require('node:path')
const store = require('./store')

const KINDS = ['ads', 'combined']
const REFRESH_AFTER_MS = 7 * 86_400_000
const BUILD_TIMEOUT_MS = 180_000
const RETRY_MS = [60_000, 300_000, 1_800_000]
const NOTIFY_MS = 300
const DEFAULTS = { ads: true, trackers: true, allowedSites: [], customRules: '' }
const MAX_CUSTOM_RULES = 100_000

// A false block costs most here: being locked out of an account or failing a payment, on pages where
// the fix isn't obvious. So these are left alone, whatever a filter list says. A page on one of
// these hosts has nothing blocked, and these hosts are never blocked from any page.
const SAFEGUARDED_HOSTS = [
  // Signing in
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'idmsa.apple.com',
  'okta.com',
  'auth0.com',
  // Paying
  'paypal.com',
  'paypalobjects.com',
  'stripe.com',
  'stripe.network',
  'adyen.com',
  'braintreegateway.com',
  'squareup.com',
  // Proving you're human
  'recaptcha.net',
  'hcaptcha.com',
  'challenges.cloudflare.com',
  'arkoselabs.com',
]
// CAPTCHA served from hosts too broad to leave alone completely.
const SAFEGUARDED_REQUESTS = [/^https:\/\/www\.google\.com\/recaptcha\//, /^https:\/\/www\.gstatic\.com\/recaptcha\//]

const engines = { ads: null, combined: null }
let customEngine = null // the rules written on the protection page
let customExceptions = null // their @@ exceptions, as rules of their own: see compileCustomRules
let refreshing = null
const counts = new Map() // webContents id → { ads, trackers }
let status = 'loading' // loading | ready | unavailable
let retries = 0
let notifyTimer = null
let pendingTotal = 0

// ── Settings ─────────────────────────────────────────────────────────────

function getSettings() {
  const saved = store.get('protection') ?? {}
  return {
    ads: typeof saved.ads === 'boolean' ? saved.ads : DEFAULTS.ads,
    trackers: typeof saved.trackers === 'boolean' ? saved.trackers : DEFAULTS.trackers,
    allowedSites: Array.isArray(saved.allowedSites) ? saved.allowedSites.filter((s) => typeof s === 'string') : [],
    customRules: typeof saved.customRules === 'string' ? saved.customRules : DEFAULTS.customRules,
  }
}

function hostOf(url) {
  try {
    const u = new URL(url)
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : null
  } catch {
    return null
  }
}

const hostIsIn = (host, list) => list.some((entry) => host === entry || host.endsWith(`.${entry}`))

function isAllowedSite(url, settings = getSettings()) {
  const host = hostOf(url)
  return Boolean(host) && hostIsIn(host, settings.allowedSites)
}

function isSafeguarded(url) {
  const host = hostOf(url)
  return Boolean(host) && hostIsIn(host, SAFEGUARDED_HOSTS)
}

/** Accepts "example.com", "www.example.com" or a whole address. Returns null for anything else. */
function normalizeSite(input) {
  const text = String(input ?? '').trim().toLowerCase()
  const host = hostOf(/^https?:\/\//.test(text) ? text : `https://${text}`)
  return host && /^[a-z0-9.-]+$/.test(host) ? host : null
}

function changed() {
  const { BrowserShell } = require('./shell')
  for (const shell of BrowserShell.all) shell.scheduleState()
}

function update(partial) {
  store.set('protection', { ...getSettings(), ...partial })
  changed()
}

function set({ ads, trackers }) {
  const partial = {}
  if (typeof ads === 'boolean') partial.ads = ads
  if (typeof trackers === 'boolean') partial.trackers = trackers
  update(partial)
}

/** Everything on or everything off. */
function toggleAll() {
  const { ads, trackers } = getSettings()
  const on = !(ads || trackers)
  update({ ads: on, trackers: on })
  return on
}

/** Turns blocking off or back on for one site, for pages it breaks. */
function toggleSite(url) {
  const host = hostOf(url)
  if (!host) return
  const settings = getSettings()
  const allowed = isAllowedSite(url, settings)
  update({
    allowedSites: allowed
      ? settings.allowedSites.filter((site) => host !== site && !host.endsWith(`.${site}`))
      : [...settings.allowedSites, host],
  })
}

function allowSite(input) {
  const site = normalizeSite(input)
  if (!site) return false
  const settings = getSettings()
  if (!settings.allowedSites.includes(site)) update({ allowedSites: [...settings.allowedSites, site] })
  return true
}

function removeAllowedSite(input) {
  const site = normalizeSite(input)
  update({ allowedSites: getSettings().allowedSites.filter((s) => s !== site) })
}

/**
 * An engine only looks at an exception when one of its own rules would block the request, so an
 * exception here could never override the filter lists. Matching them separately lets it.
 */
function compileCustomRules(text) {
  const exceptions = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('@@'))
    .map((line) => line.slice(2))
  customEngine = text.trim() ? ElectronBlocker.parse(text) : null
  customExceptions = exceptions.length ? ElectronBlocker.parse(exceptions.join('\n')) : null
}

function setCustomRules(text) {
  const rules = String(text ?? '').slice(0, MAX_CUSTOM_RULES)
  compileCustomRules(rules)
  update({ customRules: rules })
}

/** Everything the protection page shows. */
async function details() {
  const settings = getSettings()
  let lastUpdated = null
  try {
    lastUpdated = (await fs.promises.stat(cacheFile('combined'))).mtimeMs
  } catch {}
  return { ...settings, status, lastUpdated, blockedTotal: Number(store.get('protectionTotal')) || 0 }
}

/** What the toolbar shows for the page at `url`. */
function stateFor(url) {
  const settings = getSettings()
  return {
    ads: settings.ads,
    trackers: settings.trackers,
    site: hostOf(url),
    allowed: isAllowedSite(url, settings),
    status,
  }
}

function countsFor(id) {
  return counts.get(id) ?? { ads: 0, trackers: 0 }
}

// ── Blocking ─────────────────────────────────────────────────────────────

function count(webContents, kind) {
  let entry = counts.get(webContents.id)
  if (!entry) {
    entry = { ads: 0, trackers: 0 }
    counts.set(webContents.id, entry)
    const { id } = webContents
    webContents.once('destroyed', () => counts.delete(id))
  }
  entry[kind] += 1
  pendingTotal += 1
  notifyTimer ??= setTimeout(() => {
    notifyTimer = null
    store.set('protectionTotal', (Number(store.get('protectionTotal')) || 0) + pendingTotal)
    pendingTotal = 0
    changed()
  }, NOTIFY_MS)
}

function isBlocked(result) {
  return Boolean(result?.match || result?.redirect)
}

function decide(details) {
  const { webContents, resourceType, url } = details
  if (!webContents || webContents.isDestroyed()) return {}

  // A new page starts its count over. Pages themselves are never blocked.
  if (resourceType === 'mainFrame') {
    const entry = counts.get(webContents.id)
    if (entry) Object.assign(entry, { ads: 0, trackers: 0 })
    changed()
    return {}
  }

  // Only what websites load: not the browser's own pages, extensions, or downloads of extensions.
  const page = webContents.getURL()
  if (!/^https?:/.test(page) || !/^(https?|wss?):/.test(url)) return {}

  const settings = getSettings()
  if ((!settings.ads && !settings.trackers) || isAllowedSite(page, settings)) return {}
  if (isSafeguarded(page) || isSafeguarded(url) || SAFEGUARDED_REQUESTS.some((pattern) => pattern.test(url))) return {}

  const request = Request.fromRawDetails({ url, sourceUrl: page, type: resourceType || 'other', tabId: webContents.id })
  if (request.type === 'other') request.guessTypeOfRequest()

  // Your own rules come first, including exceptions to what the lists would block.
  if (isBlocked(customExceptions?.match(request))) return {}
  const custom = customEngine?.match(request)
  if (isBlocked(custom)) {
    count(webContents, 'ads')
    return { cancel: true }
  }

  const engine = settings.trackers ? engines.combined : settings.ads ? engines.ads : null
  if (!engine) return {}
  const result = engine.match(request)
  if (!isBlocked(result)) return {}

  const isAd = engine === engines.ads || isBlocked(engines.ads?.match(request))
  if (isAd && !settings.ads) return {} // only trackers are being blocked

  count(webContents, isAd ? 'ads' : 'trackers')
  return result.redirect ? { redirectURL: result.redirect.dataUrl } : { cancel: true }
}

/** Hides leftover ad boxes on the page. Uses the library's script and its message names. */
function setupCosmetics(session) {
  session.registerPreloadScript({
    type: 'frame',
    filePath: require.resolve('@ghostery/adblocker-electron-preload'),
  })
  const activeEngines = (event) => {
    const settings = getSettings()
    const page = event.sender.getURL()
    if (!/^https?:/.test(page) || isAllowedSite(page, settings) || isSafeguarded(page)) return []
    if (!settings.ads && !settings.trackers) return []
    return [settings.ads ? engines.ads : null, customEngine].filter(Boolean)
  }
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', async (event, url, message) => {
    // Corrections to what the library does with its `event.sender`:
    // - It runs scripts in the main frame, whichever frame asked. They go to the frame that asked.
    // - A page can get several scripts that declare the same names, which throws if they share a
    //   scope. So each one gets its own.
    // - It doesn't wait for them. They fail harmlessly when a page navigates away mid-way, and that
    //   would otherwise surface as an unhandled error.
    const { sender, senderFrame } = event
    const corrected = {
      frameId: event.frameId,
      processId: event.processId,
      sender: {
        insertCSS: (...args) => sender.insertCSS(...args).catch(() => {}),
        executeJavaScript: (code, ...args) => senderFrame?.executeJavaScript(`{\n${code}\n}`, ...args).catch(() => {}),
      },
    }
    for (const engine of activeEngines(event)) await engine.onInjectCosmeticFilters(corrected, url, message)
  })
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (event) =>
    activeEngines(event).some((engine) => engine.config.enableMutationObserver),
  )
}

// ── Filter lists ─────────────────────────────────────────────────────────

const cacheDir = () => path.join(app.getPath('userData'), 'blocklists')
const cacheFile = (kind) => path.join(cacheDir(), `${kind}.bin`)

async function readCached(kind) {
  try {
    const buffer = await fs.promises.readFile(cacheFile(kind))
    engines[kind] = ElectronBlocker.deserialize(new Uint8Array(buffer))
    return true
  } catch {
    return false // not downloaded yet, or saved by a different version of the library
  }
}

function build(kind) {
  return new Promise((resolve, reject) => {
    const temp = `${cacheFile(kind)}.tmp`
    const worker = new Worker(path.join(__dirname, 'blocker-worker.js'), { workerData: { kind, file: temp } })
    worker.unref()
    const timer = setTimeout(() => {
      worker.terminate()
      reject(new Error('Timed out'))
    }, BUILD_TIMEOUT_MS)
    timer.unref?.()
    worker.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    worker.once('message', (result) => {
      clearTimeout(timer)
      if (!result.ok) return reject(new Error(result.error))
      fs.promises
        .rename(temp, cacheFile(kind))
        .then(() => readCached(kind))
        .then(resolve, reject)
    })
  })
}

function refresh() {
  refreshing ??= runRefresh().finally(() => {
    refreshing = null
  })
  return refreshing
}

async function runRefresh() {
  try {
    await fs.promises.mkdir(cacheDir(), { recursive: true })
    for (const kind of KINDS) await build(kind) // one at a time: compiling is heavy
    status = 'ready'
    retries = 0
  } catch (err) {
    console.error('Could not update the ad and tracker filter lists:', err.message)
    if (!KINDS.every((kind) => engines[kind])) status = 'unavailable'
    const delay = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)]
    retries += 1
    setTimeout(refresh, delay).unref?.()
  }
  changed()
}

async function isStale() {
  try {
    const stats = await Promise.all(KINDS.map((kind) => fs.promises.stat(cacheFile(kind))))
    return stats.some((s) => Date.now() - s.mtimeMs > REFRESH_AFTER_MS)
  } catch {
    return true
  }
}

/**
 * Starts blocking. Saved filter lists are in use by the time this finishes, so restored tabs are
 * covered from the start. Downloading happens in the background and never holds up the window.
 */
async function init(session) {
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    try {
      callback(decide(details))
    } catch (err) {
      console.error('Blocker error:', err)
      callback({})
    }
  })
  setupCosmetics(session)
  compileCustomRules(getSettings().customRules)

  const loaded = await Promise.all(KINDS.map(readCached))
  const complete = loaded.every(Boolean)
  if (complete) status = 'ready'
  if (process.env.GLASSWING_SKIP_BLOCKLIST_DOWNLOAD) return
  if (!complete || (await isStale())) refresh()
}

/** Lets the smoke test use its own small filter lists. */
function useFilters({ ads, trackers }) {
  engines.ads = ElectronBlocker.parse(ads)
  engines.combined = ElectronBlocker.parse(`${ads}\n${trackers}`)
  status = 'ready'
}

module.exports = {
  init,
  getSettings,
  set,
  toggleAll,
  toggleSite,
  allowSite,
  removeAllowedSite,
  setCustomRules,
  details,
  refresh,
  isSafeguarded,
  stateFor,
  countsFor,
  useFilters,
}
