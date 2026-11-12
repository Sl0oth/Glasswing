// Devices on your own network (routers, printers, home servers, dashboards) often make their own
// security certificate, which no authority vouches for, so Chromium refuses them. For those
// addresses only, Glasswing lets you continue anyway, and remembers that exact certificate.
// Public sites never get this: a bad certificate there is more likely someone in the middle.
const { app, session } = require('electron')
const store = require('./store')

const STORE_KEY = 'trustedCertificates' // { "host:port": fingerprint }
const sessionOnly = new Map() // the same, for private windows: forgotten when Glasswing closes
const failed = new Map() // webContents id → { url, site, fingerprint, error } for the last refused page

function isLocalAddress(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (host.includes(':')) return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
  if (!host.includes('.')) return host.length > 0 // a single name like "nas" only exists on your network
  return /\.(localhost|local|lan|home\.arpa|internal)$/.test(host)
}

function siteOf(url) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'wss:') return null
    return { site: `${u.hostname}:${u.port || 443}`, hostname: u.hostname }
  } catch {
    return null
  }
}

const isPrivate = (wc) => Boolean(wc && !wc.isDestroyed() && wc.session !== session.defaultSession)
const saved = () => store.get(STORE_KEY) ?? {}

function trustedFingerprint(site, wc) {
  return isPrivate(wc) ? sessionOnly.get(site) : saved()[site]
}

function setup() {
  app.on('certificate-error', (event, wc, url, error, certificate, callback, isMainFrame) => {
    const where = siteOf(url)
    if (where && isLocalAddress(where.hostname) && trustedFingerprint(where.site, wc) === certificate.fingerprint) {
      event.preventDefault()
      callback(true)
      return
    }
    // Noted before refusing, so it's there when the page reports the failed load.
    if (isMainFrame && where && isLocalAddress(where.hostname) && wc) {
      if (!failed.has(wc.id)) wc.once('destroyed', () => failed.delete(wc.id))
      failed.set(wc.id, { url, site: where.site, fingerprint: certificate.fingerprint, error })
    }
    callback(false)
  })
}

/** What to offer when a page couldn't load: a refused certificate you can choose to continue past, or null. */
function refusedFor(wc, url) {
  const entry = failed.get(wc.id)
  return entry && entry.url === url ? entry : null
}

function trust(wc, entry) {
  failed.delete(wc.id)
  if (isPrivate(wc)) {
    sessionOnly.set(entry.site, entry.fingerprint)
    return
  }
  store.set(STORE_KEY, { ...saved(), [entry.site]: entry.fingerprint })
}

/** True if the page is showing because you chose to continue past its certificate. */
function isOverridden(url, wc) {
  const where = siteOf(url)
  return Boolean(where && isLocalAddress(where.hostname) && trustedFingerprint(where.site, wc))
}

function forgetAll() {
  sessionOnly.clear()
  store.set(STORE_KEY, undefined)
}

module.exports = { setup, refusedFor, trust, isOverridden, forgetAll, isLocalAddress }
