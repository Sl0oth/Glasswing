// "Clear browsing data": history, cookies & site data, cache, downloads, saved passwords.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const history = require('./history')
const store = require('./store')

const RANGES = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 28 * 86_400_000,
  all: Infinity,
}

const SITE_DATA = ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'webSQL', 'backgroundFetch']

async function clearBrowsingData(session, options = {}) {
  const span = RANGES[options.range] ?? RANGES.hour
  const since = span === Infinity ? 0 : Date.now() - span
  // Work out which sites were visited in the range before history is deleted.
  const visitedOrigins = history.originsSince(since)

  if (options.history) history.clear(since)

  if (options.cookies) {
    // Never wipe extensions' own storage (their settings, logins, ...).
    const extensionOrigins = session.extensions.getAllExtensions().map((e) => `chrome-extension://${e.id}`)
    if (since === 0) {
      await session.clearData({ dataTypes: SITE_DATA, excludeOrigins: extensionOrigins })
      fs.rmSync(path.join(app.getPath('userData'), 'session-cookies.bin'), { force: true })
    } else if (visitedOrigins.length) {
      // Chromium can't clear cookies by date; clear the sites visited during the period instead.
      await session.clearData({ dataTypes: SITE_DATA, origins: visitedOrigins })
    }
  }

  if (options.cache) await session.clearCache()

  if (options.downloads) require('./downloads').downloadAction('clear')

  if (options.passwords) {
    const kept = (store.get('passwords') ?? []).filter((p) => p.lastUsed < since)
    store.set('passwords', since === 0 ? [] : kept)
  }

  return { ok: true, sites: visitedOrigins.length }
}

module.exports = { clearBrowsingData, RANGES }
