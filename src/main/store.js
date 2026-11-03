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

function load() {
  file = path.join(app.getPath('userData'), 'glasswing.json')
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    data = {}
  }
  data.favorites ??= DEFAULT_FAVORITES.slice()
  data.history ??= []
  data.permissions ??= {}
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

function flush() {
  clearTimeout(saveTimer)
  if (!data) return
  try {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data))
    fs.renameSync(tmp, file)
  } catch (err) {
    console.error('Failed to save state:', err)
  }
}

module.exports = { get, set, flush }
