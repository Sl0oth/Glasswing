// Each site's icon, kept on disk so a tab that isn't loaded (restored at startup, or asleep) still shows
// what it is. Saved per site as a small image, not a link, so showing it doesn't contact the site again.
// Private windows' icons are never written down.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const MAX_SITES = 400
const MAX_BYTES = 64 * 1024 // a site's icon bigger than this isn't kept
const SAVE_DELAY_MS = 2000

let icons = null // host → { data, at }, oldest first
let saveTimer = null
const fetching = new Set()

const file = () => path.join(app.getPath('userData'), 'favicons.json')

function load() {
  if (icons) return icons
  icons = new Map()
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'))
    for (const [host, entry] of Object.entries(saved)) {
      if (typeof entry?.data === 'string' && entry.data.startsWith('data:image/')) icons.set(host, entry)
    }
  } catch {}
  return icons
}

function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flush, SAVE_DELAY_MS)
}

function flush() {
  clearTimeout(saveTimer)
  saveTimer = null
  if (!icons) return
  try {
    const temp = `${file()}.tmp`
    fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(icons)))
    fs.renameSync(temp, file())
  } catch (err) {
    console.error('Could not save site icons:', err)
  }
}

function hostOf(url) {
  try {
    const u = new URL(url)
    return /^https?:$/.test(u.protocol) ? u.host : null
  } catch {
    return null
  }
}

function put(host, data) {
  const map = load()
  if (map.get(host)?.data === data) return
  map.delete(host) // re-adding puts it last, as the newest
  map.set(host, { data, at: Date.now() })
  while (map.size > MAX_SITES) map.delete(map.keys().next().value)
  save()
}

/** The page at `pageUrl` showed `iconUrl`: keep a copy. Fetched through the page's own session, so it's blocked and proxied the same way. */
async function remember(pageUrl, iconUrl, session, { isPrivate = false } = {}) {
  const host = hostOf(pageUrl)
  if (!host || !iconUrl || isPrivate) return
  if (iconUrl.startsWith('data:image/')) {
    if (iconUrl.length <= MAX_BYTES * 1.4) put(host, iconUrl)
    return
  }
  if (!/^https?:/.test(iconUrl)) return
  const key = `${host} ${iconUrl}`
  if (fetching.has(key)) return
  fetching.add(key)
  try {
    const response = await session.fetch(iconUrl, { credentials: 'omit', signal: AbortSignal.timeout(10000) })
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!response.ok || !/^image\/[a-z0-9.+-]+$/.test(type)) return
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return
    put(host, `data:${type};base64,${bytes.toString('base64')}`)
  } catch {
    // Offline, blocked or slow: the live icon still shows while the page is open.
  } finally {
    fetching.delete(key)
  }
}

/** The saved icon for the site at `url`, or null. */
function cachedFor(url) {
  const host = hostOf(url)
  return host ? load().get(host)?.data ?? null : null
}

function clear() {
  icons = new Map()
  clearTimeout(saveTimer)
  saveTimer = null
  fs.rmSync(file(), { force: true })
}

module.exports = { remember, cachedFor, clear, flush }
