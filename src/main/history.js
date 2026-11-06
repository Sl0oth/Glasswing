// Browsing history: address bar suggestions, the + button's recent list, and glasswing://history.
const store = require('./store')

const MAX_ENTRIES = 5000
const DAY = 86_400_000

const DEFAULT_SETTINGS = {
  enabled: true, // record history at all
  retentionDays: 0, // remove items older than N days; 0 = keep forever
  clearOnExit: false,
}

let entries = null // Map<url, { url, title, visits, lastVisit }>

function load() {
  if (entries) return
  entries = new Map()
  for (const entry of store.get('history')) {
    if (typeof entry?.url !== 'string') continue
    entries.set(entry.url, {
      url: entry.url,
      title: typeof entry.title === 'string' ? entry.title : '',
      visits: Number(entry.visits) || 1,
      lastVisit: Number(entry.lastVisit) || 0,
    })
  }
  prune()
}

function save() {
  let list = [...entries.values()]
  if (list.length > MAX_ENTRIES) {
    list.sort((a, b) => b.lastVisit - a.lastVisit)
    list = list.slice(0, MAX_ENTRIES)
    entries = new Map(list.map((e) => [e.url, e]))
  }
  store.set('history', list)
}

// ── Settings ─────────────────────────────────────────────────────────────

function getSettings() {
  const s = { ...DEFAULT_SETTINGS, ...(store.get('historySettings') ?? {}) }
  return {
    enabled: Boolean(s.enabled),
    retentionDays: [0, 1, 7, 14, 30, 365].includes(Number(s.retentionDays)) ? Number(s.retentionDays) : 0,
    clearOnExit: Boolean(s.clearOnExit),
  }
}

function setSettings(partial) {
  const next = { ...getSettings(), ...(partial ?? {}) }
  store.set('historySettings', next)
  const clean = getSettings()
  if (entries) prune()
  return clean
}

/** Applies "Remove history items after…". */
function prune() {
  const { retentionDays } = getSettings()
  if (!retentionDays || !entries) return
  const cutoff = Date.now() - retentionDays * DAY
  let changed = false
  for (const [url, entry] of entries) {
    if (entry.lastVisit < cutoff) {
      entries.delete(url)
      changed = true
    }
  }
  if (changed) save()
}

// ── Recording ────────────────────────────────────────────────────────────

function isRecordable(url) {
  return /^https?:\/\//i.test(url)
}

function record(url, title) {
  if (!isRecordable(url) || !getSettings().enabled) return
  load()
  const entry = entries.get(url) ?? { url, title: '', visits: 0, lastVisit: 0 }
  entry.visits += 1
  entry.lastVisit = Date.now()
  if (title && title !== url) entry.title = title
  entries.set(url, entry)
  save()
}

/**
 * Adds entries from another browser, keeping the newest visit and the higher count for pages already
 * known. Works whether or not history is being recorded: importing it was asked for specifically.
 * Returns how many entries there were to add.
 */
function importEntries(list) {
  load()
  let count = 0
  for (const item of list) {
    if (!isRecordable(item.url)) continue
    count += 1
    const entry = entries.get(item.url)
    if (entry) {
      entry.visits = Math.max(entry.visits, item.visits)
      entry.lastVisit = Math.max(entry.lastVisit, item.lastVisit)
      entry.title ||= item.title
    } else {
      entries.set(item.url, { url: item.url, title: item.title, visits: item.visits, lastVisit: item.lastVisit })
    }
  }
  save()
  return count
}

function updateTitle(url, title) {
  load()
  const entry = entries.get(url)
  if (entry && title && title !== url) {
    entry.title = title
    save()
  }
}

// ── Queries ──────────────────────────────────────────────────────────────

function strip(url) {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
}

function score(entry) {
  const ageDays = (Date.now() - entry.lastVisit) / DAY
  return entry.visits / (1 + ageDays / 7)
}

/** Best matches for the address bar, plus an inline completion ("git" → "github.com/"). */
function query(text, limit = 4) {
  load()
  const needle = text.toLowerCase()
  const prefix = []
  const contains = []
  for (const entry of entries.values()) {
    const bare = strip(entry.url).toLowerCase()
    if (bare.startsWith(needle)) prefix.push(entry)
    else if (bare.includes(needle) || entry.title.toLowerCase().includes(needle)) contains.push(entry)
  }
  prefix.sort((a, b) => score(b) - score(a))
  contains.sort((a, b) => score(b) - score(a))

  let completion = null
  if (needle && !/\s/.test(needle)) {
    const hosts = prefix
      .map((e) => strip(e.url).match(/^[^/?#]+\/?/)[0])
      .filter((h) => h.toLowerCase().startsWith(needle))
    completion = hosts[0] ?? null
    if (completion && !completion.endsWith('/')) completion += '/'
  }

  const results = [...prefix, ...contains].slice(0, limit).map(({ url, title }) => ({ url, title }))
  return { results, completion }
}

/** Most recently visited pages, newest first, skipping near-duplicates (same title on the same site). */
function recent(limit = 10) {
  load()
  const seen = new Set()
  const result = []
  for (const entry of [...entries.values()].sort((a, b) => b.lastVisit - a.lastVisit)) {
    let host = entry.url
    try {
      host = new URL(entry.url).host
    } catch {}
    const key = `${host}\n${entry.title || entry.url}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ url: entry.url, title: entry.title, lastVisit: entry.lastVisit })
    if (result.length === limit) break
  }
  return result
}

/** Paged list for the history page, optionally filtered by a search term. */
function list({ search = '', offset = 0, limit = 200 } = {}) {
  load()
  const needle = search.trim().toLowerCase()
  const all = [...entries.values()]
    .filter((e) => !needle || e.url.toLowerCase().includes(needle) || e.title.toLowerCase().includes(needle))
    .sort((a, b) => b.lastVisit - a.lastVisit)
  return {
    total: all.length,
    items: all.slice(offset, offset + limit).map(({ url, title, visits, lastVisit }) => ({ url, title, visits, lastVisit })),
  }
}

function remove(url) {
  load()
  if (entries.delete(url)) save()
}

/** Deletes history visited since `since` (ms timestamp; 0 = everything). Returns affected origins. */
function clear(since = 0) {
  load()
  const origins = new Set()
  for (const [url, entry] of entries) {
    if (entry.lastVisit >= since) {
      try {
        origins.add(new URL(url).origin)
      } catch {}
      entries.delete(url)
    }
  }
  save()
  return [...origins]
}

/** Origins visited since `since`, without deleting anything. */
function originsSince(since) {
  load()
  const origins = new Set()
  for (const entry of entries.values()) {
    if (entry.lastVisit < since) continue
    try {
      origins.add(new URL(entry.url).origin)
    } catch {}
  }
  return [...origins]
}

module.exports = {
  record,
  importEntries,
  updateTitle,
  query,
  recent,
  list,
  remove,
  clear,
  originsSince,
  getSettings,
  setSettings,
}
