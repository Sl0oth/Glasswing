// The favorites list, shared by the favorites bar, the star button and the new tab page.
const store = require('./store')

const MAX_FAVORITES = 100

let cache = null

function normalizeUrl(value) {
  try {
    const url = new URL(String(value))
    return /^https?:$/.test(url.protocol) ? url.href.slice(0, 2048) : null
  } catch {
    return null
  }
}

/** Drops invalid entries and duplicates. Returns null if `input` isn't a list at all. */
function clean(input) {
  if (!Array.isArray(input)) return null
  const seen = new Set()
  const result = []
  for (const item of input) {
    const url = normalizeUrl(item?.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    result.push({ title: String(item.title ?? '').trim().slice(0, 80), url })
    if (result.length === MAX_FAVORITES) break
  }
  return result
}

function list() {
  cache ??= clean(store.get('favorites')) ?? []
  return cache
}

function commit(next) {
  cache = next
  store.set('favorites', next)
  const { BrowserShell } = require('./shell')
  for (const shell of BrowserShell.all) shell.favoritesChanged(next)
  return next
}

function has(url) {
  const target = normalizeUrl(url)
  return Boolean(target) && list().some((f) => f.url === target)
}

function add({ title, url }) {
  return commit(clean([...list(), { title, url }]))
}

function remove(url) {
  const target = normalizeUrl(url)
  return commit(list().filter((f) => f.url !== target))
}

/** Replaces one entry in place. Returns false if the new address isn't a web address. */
function update(url, { title, url: nextUrl }) {
  const target = normalizeUrl(url)
  if (!normalizeUrl(nextUrl)) return false
  commit(clean(list().map((f) => (f.url === target ? { title, url: nextUrl } : f))))
  return true
}

function move(url, toIndex) {
  const target = normalizeUrl(url)
  const items = list().slice()
  const from = items.findIndex((f) => f.url === target)
  if (from < 0 || !Number.isFinite(toIndex)) return
  const [item] = items.splice(from, 1)
  items.splice(Math.max(0, Math.min(toIndex, items.length)), 0, item)
  commit(items)
}

/** Replaces the whole list (new tab page). Returns null if `input` isn't a list. */
function replace(input) {
  const next = clean(input)
  return next && commit(next)
}

/** Is this still the list every new profile starts with? */
function isUntouched() {
  const urls = list().map((f) => f.url)
  const starters = clean(store.DEFAULT_FAVORITES).map((f) => f.url)
  return urls.length === starters.length && urls.every((url, i) => url === starters[i])
}

module.exports = { list, has, add, remove, update, move, replace, isUntouched, MAX_FAVORITES }
