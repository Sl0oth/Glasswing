// Tiny JSON-file store for favorites, history, permissions and the last session.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_FAVORITES = [
  { title: 'DuckDuckGo', url: 'https://duckduckgo.com/' },
  { title: 'YouTube', url: 'https://www.youtube.com/' },
  { title: 'GitHub', url: 'https://github.com/' },
  { title: 'Reddit', url: 'https://www.reddit.com/' },
  { title: 'Wikipedia', url: 'https://www.wikipedia.org/' },
  { title: 'Web Store', url: 'https://chromewebstore.google.com/' },
]

let data = null
let file = null
let saveTimer = null

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function load() {
  file = path.join(app.getPath('userData'), 'glasswing.json')
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!isPlainObject(data)) throw new Error('Saved state is not an object')
  } catch (err) {
    data = {}
    // Keep a damaged file for recovery rather than overwriting it on the next save.
    if (err.code !== 'ENOENT') {
      console.error('Saved state could not be read:', err.message)
      try {
        fs.renameSync(file, `${file}.corrupt`)
      } catch {}
    }
  }
  if (!Array.isArray(data.favorites)) data.favorites = DEFAULT_FAVORITES.slice()
  if (!Array.isArray(data.history)) data.history = []
  if (!isPlainObject(data.permissions)) data.permissions = {}
  data.session ??= null
}

function get(key) {
  if (!data) load()
  return data[key]
}

function set(key, value) {
  if (!data) load()
  data[key] = value
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flush, 500)
}

/**
 * All on disk before it replaces the old file, so if the computer crashes you're left with one or the
 * other. Without the sync, Windows can record the swap before the contents, leaving a damaged file.
 */
function writeFileSafely(target, contents) {
  const tmp = `${target}.tmp`
  const handle = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(handle, contents)
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  fs.renameSync(tmp, target)
}

function flush() {
  clearTimeout(saveTimer)
  if (!data) return
  try {
    writeFileSafely(file, JSON.stringify(data))
  } catch (err) {
    console.error('Failed to save state:', err)
  }
}

module.exports = { get, set, flush, writeFileSafely, DEFAULT_FAVORITES }
