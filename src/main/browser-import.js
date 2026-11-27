// Brings bookmarks, history and a few settings over from Chrome, Brave and Edge.
//
// These browsers all keep a profile the same way. Their files are only ever read, and only the
// files named here: not passwords, cookies or payment details, which they encrypt for themselves.
const fs = require('node:fs')
const path = require('node:path')
const favorites = require('./favorites')
const history = require('./history')
const appearance = require('./appearance')
const search = require('./search')

const BROWSERS = [
  { id: 'chrome', name: 'Chrome', dir: ['Google', 'Chrome', 'User Data'], defaultSearch: 'google' },
  { id: 'brave', name: 'Brave', dir: ['BraveSoftware', 'Brave-Browser', 'User Data'], defaultSearch: 'brave' },
  { id: 'edge', name: 'Edge', dir: ['Microsoft', 'Edge', 'User Data'], defaultSearch: 'bing' },
]

const MAX_HISTORY = 5000
// Chromium counts time in microseconds from the year 1601.
const CHROMIUM_EPOCH_OFFSET_MS = 11_644_473_600_000

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}

const isWebUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url)

const browserRoot = (browser) => path.join(process.env.LOCALAPPDATA ?? '', ...browser.dir)

/** Every profile of every browser found on this computer. */
function profilesOf(browser) {
  const root = browserRoot(browser)
  const state = readJson(path.join(root, 'Local State'))?.profile
  const info = state?.info_cache
  const names = info && typeof info === 'object' ? Object.keys(info) : ['Default']
  return names
    .filter((name) => !name.includes('..') && !path.isAbsolute(name))
    .map((name) => ({
      dir: name,
      name: info?.[name]?.name || name,
      path: path.join(root, name),
      lastUsed: state?.last_used === name,
      activeTime: Number(info?.[name]?.active_time) || 0,
    }))
    .filter((profile) => fs.existsSync(path.join(profile.path, 'Preferences')) || fs.existsSync(path.join(profile.path, 'Bookmarks')))
}

// ── Bookmarks ────────────────────────────────────────────────────────────

/** The bookmarks in reading order: what's directly on the bar first, then folders, then the rest. */
function readBookmarks(profilePath) {
  const roots = readJson(path.join(profilePath, 'Bookmarks'))?.roots
  if (!roots) return []
  const direct = []
  const nested = []
  const walk = (node, depth) => {
    for (const child of Array.isArray(node?.children) ? node.children : []) {
      if (child?.type === 'url' && isWebUrl(child.url)) {
        ;(depth === 0 ? direct : nested).push({ title: String(child.name ?? ''), url: child.url })
      } else if (child?.type === 'folder') {
        walk(child, depth + 1)
      }
    }
  }
  walk(roots.bookmark_bar, 0)
  walk(roots.other, 1)
  walk(roots.synced, 1)
  const seen = new Set()
  return [...direct, ...nested].filter(({ url }) => !seen.has(url) && seen.add(url))
}

// ── History and the search engine: both in SQLite databases ──────────────

/**
 * Reads a database the browser may have open. `immutable` tells SQLite not to wait on the browser's
 * locks or write anything next to the file.
 */
function readDatabase(file, read) {
  if (!fs.existsSync(file)) return null
  const { DatabaseSync } = require('node:sqlite')
  const uri = `file:///${file.replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/').replace('%3A', ':')}?immutable=1`
  let db
  try {
    db = new DatabaseSync(uri, { readOnly: true })
    return read(db)
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {}
  }
}

const VISIBLE_WEB_PAGES = `hidden = 0 AND (url LIKE 'http://%' OR url LIKE 'https://%')`

function historyCount(profilePath) {
  return readDatabase(path.join(profilePath, 'History'), (db) => db.prepare(`SELECT COUNT(*) AS n FROM urls WHERE ${VISIBLE_WEB_PAGES}`).get().n) ?? 0
}

function readHistory(profilePath) {
  // The time is divided here because in microseconds it's too large for a JavaScript number.
  const rows = readDatabase(path.join(profilePath, 'History'), (db) =>
    db
      .prepare(`SELECT url, title, visit_count AS visits, last_visit_time / 1000 AS time FROM urls WHERE ${VISIBLE_WEB_PAGES} ORDER BY last_visit_time DESC LIMIT ?`)
      .all(MAX_HISTORY),
  )
  return (rows ?? []).map((row) => ({
    url: row.url,
    title: String(row.title ?? ''),
    visits: Number(row.visits) || 1,
    lastVisit: Math.max(0, Number(row.time) - CHROMIUM_EPOCH_OFFSET_MS),
  }))
}

/** Works out the browser's search engine, if it's one Glasswing offers. */
function readSearchEngine(browser, profilePath, preferences) {
  const chosen = preferences?.default_search_provider_data?.template_url_data?.url
  if (chosen) return search.idFromUrl(chosen)
  const guid = preferences?.default_search_provider?.guid
  if (guid) {
    const url = readDatabase(path.join(profilePath, 'Web Data'), (db) => db.prepare('SELECT url FROM keywords WHERE sync_guid = ?').get(guid)?.url)
    if (url) return search.idFromUrl(url)
  }
  return browser.defaultSearch
}

// ── What the setup window asks for ───────────────────────────────────────

/** What can be imported, for showing before anything happens. */
function detect() {
  const found = []
  for (const browser of BROWSERS) {
    const profiles = profilesOf(browser).map((profile) => {
      const preferences = readJson(path.join(profile.path, 'Preferences'))
      return {
        dir: profile.dir,
        name: profile.name,
        lastUsed: profile.lastUsed,
        activeTime: profile.activeTime,
        bookmarks: readBookmarks(profile.path).length,
        history: historyCount(profile.path),
        hasSettings: Boolean(preferences),
      }
    })
    if (profiles.length) found.push({ id: browser.id, name: browser.name, profiles })
  }
  return found
}

/** Keeps the starter favorites only if they've been changed; otherwise yours replace them. */
function mergeFavorites(bookmarks) {
  const room = favorites.MAX_FAVORITES
  const base = favorites.isUntouched() ? [] : favorites.list()
  const known = new Set(base.map((f) => f.url))
  const fresh = bookmarks.filter((b) => {
    if (known.has(b.url)) return false
    known.add(b.url)
    return true
  })
  if (!fresh.length) return { favorites: 0, rest: [] }
  const accepted = fresh.slice(0, Math.max(0, room - base.length))
  favorites.replace([...base, ...accepted])
  return { favorites: accepted.length, rest: fresh.slice(accepted.length) }
}

/**
 * Imports from one profile. `what` picks any of bookmarks, history and settings. One part failing
 * doesn't stop the others; the result says what happened.
 */
function run(browserId, profileDir, what = {}) {
  const browser = BROWSERS.find((b) => b.id === browserId)
  const profile = browser && profilesOf(browser).find((p) => p.dir === profileDir)
  if (!profile) return { ok: false, error: 'That browser or profile wasn’t found.' }

  const result = { ok: true, favorites: 0, moreBookmarks: 0, history: 0, settings: [], failed: [] }
  const attempt = (name, step) => {
    try {
      step()
    } catch (err) {
      console.error(`Importing ${name} failed:`, err)
      result.failed.push(name)
    }
  }

  if (what.bookmarks) {
    attempt('bookmarks', () => {
      const { favorites: added, rest } = mergeFavorites(readBookmarks(profile.path))
      result.favorites = added
      // Favorites are limited to what fits a bar. The rest still come up as you type in the address bar.
      result.moreBookmarks = history.importEntries(rest.map((b) => ({ ...b, visits: 1, lastVisit: 0 })))
    })
  }
  if (what.history) {
    attempt('history', () => {
      result.history = history.importEntries(readHistory(profile.path))
    })
  }
  if (what.settings) {
    attempt('settings', () => {
      const preferences = readJson(path.join(profile.path, 'Preferences'))
      const engine = readSearchEngine(browser, profile.path, preferences)
      if (engine) {
        search.set(engine)
        result.settings.push(`search with ${search.current().name}`)
      }
      const showBar = preferences?.bookmark_bar?.show_on_all_tabs
      if (typeof showBar === 'boolean') {
        appearance.update({ favoritesBar: showBar })
        result.settings.push(`favorites bar ${showBar ? 'on' : 'off'}`)
      }
    })
  }
  return result
}

module.exports = { detect, run, BROWSERS }
