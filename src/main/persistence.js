// Cookies, localStorage, IndexedDB etc. already live on disk in the default session. This adds
// what Chrome's "continue where you left off" does: session cookies (no expiry date, e.g. many
// logins) survive a restart. They're encrypted with the OS keystore (DPAPI on Windows).
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { writeFileSafely } = require('./store')

const SAVE_AFTER_CHANGE_MS = 30_000

const file = () => path.join(app.getPath('userData'), 'session-cookies.bin')

async function saveSessionCookies(session) {
  if (!safeStorage.isEncryptionAvailable()) return // never write cookies in plaintext
  const cookies = (await session.cookies.get({})).filter((c) => c.session)
  writeFileSafely(file(), safeStorage.encryptString(JSON.stringify(cookies)))
}

/**
 * Saves soon after they change, not just when quitting. Otherwise a crash brings back an old copy,
 * which signs you out of sites, or back in to one you'd signed out of.
 */
function keepSessionCookiesSaved(session, delay = SAVE_AFTER_CHANGE_MS) {
  let timer = null
  session.cookies.on('changed', (_event, cookie) => {
    if (!cookie.session || timer) return
    timer = setTimeout(() => {
      timer = null
      saveSessionCookies(session).catch((err) => console.error('Could not save session cookies:', err))
    }, delay)
    timer.unref?.()
  })
}

async function restoreSessionCookies(session) {
  let cookies
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(file())) return
    cookies = JSON.parse(safeStorage.decryptString(fs.readFileSync(file())))
  } catch {
    return
  }
  if (!Array.isArray(cookies)) return
  await Promise.all(
    cookies.map((c) => {
      const host = String(c?.domain ?? '').replace(/^\./, '')
      if (!host) return null
      return session.cookies
        .set({
          url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
          name: c.name,
          value: c.value,
          ...(c.hostOnly ? {} : { domain: c.domain }),
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
        })
        .catch(() => {})
    }),
  )
}

/** Runs `promise`, logging if it's slow; never waits longer than `ms`. */
function timed(name, promise, ms) {
  const started = Date.now()
  const result = Promise.resolve(promise).finally(() => {
    const took = Date.now() - started
    if (took > 1000) console.warn(`[quit] ${name} took ${took}ms`)
  })
  const timeout = new Promise((resolve) =>
    setTimeout(() => {
      console.warn(`[quit] ${name} still running after ${ms}ms; quitting anyway`)
      resolve()
    }, ms),
  )
  return Promise.race([result, timeout])
}

/** Writes everything to disk. Call before quitting; never blocks quitting for more than ~3s. */
async function flushAll(session) {
  await Promise.allSettled([
    timed('save session cookies', saveSessionCookies(session), 3000),
    timed('flush cookie store', session.cookies.flushStore(), 3000),
    timed('flush storage data', session.flushStorageData(), 3000),
  ])
}

module.exports = { restoreSessionCookies, keepSessionCookiesSaved, flushAll }
