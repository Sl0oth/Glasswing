// Cookies, localStorage, IndexedDB etc. already live on disk in the default session. This adds
// what Chrome's "continue where you left off" does: session cookies (no expiry date, e.g. many
// logins) survive a restart. They're encrypted with the OS keystore (DPAPI on Windows).
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const file = () => path.join(app.getPath('userData'), 'session-cookies.bin')

async function saveSessionCookies(session) {
  if (!safeStorage.isEncryptionAvailable()) return // never write cookies in plaintext
  const cookies = (await session.cookies.get({})).filter((c) => c.session)
  fs.writeFileSync(file(), safeStorage.encryptString(JSON.stringify(cookies)))
}

async function restoreSessionCookies(session) {
  let cookies
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(file())) return
    cookies = JSON.parse(safeStorage.decryptString(fs.readFileSync(file())))
  } catch {
    return
  }
  await Promise.all(
    cookies.map((c) => {
      const host = c.domain.replace(/^\./, '')
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

module.exports = { restoreSessionCookies, flushAll }
