// Serves the browser's own pages (glasswing://ui, glasswing://newtab, ...) and a small JSON API
// that those pages call with same-origin fetch (e.g. glasswing://newtab/api/favorites).
const { net, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { SCHEME, SUGGEST_URL } = require('./constants')
const store = require('./store')

const SRC_ROOT = path.join(__dirname, '..')
const HOSTS = {
  ui: path.join(SRC_ROOT, 'renderer'),
  newtab: path.join(SRC_ROOT, 'pages', 'newtab'),
  extensions: path.join(SRC_ROOT, 'pages', 'extensions'),
  passwords: path.join(SRC_ROOT, 'pages', 'passwords'),
  history: path.join(SRC_ROOT, 'pages', 'history'),
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const notFound = () => new Response('Not found', { status: 404 })
const forbidden = () => new Response('Forbidden', { status: 403 })

async function fetchSuggestions(query) {
  if (!query.trim()) return []
  try {
    const url = SUGGEST_URL.replace('%s', encodeURIComponent(query))
    const res = await net.fetch(url, { signal: AbortSignal.timeout(2500) })
    const body = await res.json()
    // `type=list` returns ["query", ["a", "b"]]; the legacy format is [{ phrase }].
    const list = Array.isArray(body?.[1]) ? body[1] : body.map((item) => item?.phrase)
    return list.filter((s) => typeof s === 'string').slice(0, 8)
  } catch {
    return []
  }
}

// Electron doesn't send Origin/Referer for custom-scheme requests, so internal pages prove who they
// are with a per-session secret embedded in their HTML (websites can't read those pages).
const TOKEN = crypto.randomUUID()

/** Mutating endpoints only accept requests from our own pages. */
function isTrusted(request) {
  return request.headers.get('x-glasswing-token') === TOKEN
}

function sanitizeFavorites(list) {
  if (!Array.isArray(list)) return null
  return list
    .filter((f) => f && typeof f.url === 'string' && /^https?:\/\//i.test(f.url))
    .slice(0, 48)
    .map((f) => ({ title: String(f.title ?? '').slice(0, 80), url: f.url.slice(0, 2048) }))
}

function extensionSummary(ext) {
  const m = ext.manifest ?? {}
  const options = m.options_ui?.page ?? m.options_page
  return {
    id: ext.id,
    name: ext.name,
    version: ext.version,
    description: m.description ?? '',
    hasOptions: Boolean(options),
  }
}

function extensionIconPath(ext) {
  const icons = ext.manifest?.icons ?? {}
  const sizes = Object.keys(icons).map(Number).sort((a, b) => b - a)
  const best = sizes.find((s) => s <= 128) ?? sizes[0]
  return best ? path.join(ext.path, icons[best]) : null
}

async function handleApi(request, url) {
  const host = url.host
  const route = url.pathname.replace(/^\/api\//, '').split('/')
  const method = request.method

  if (route[0] === 'suggest' && method === 'GET') {
    return json(await fetchSuggestions(url.searchParams.get('q') ?? ''))
  }

  if (route[0] === 'favorites' && host === 'newtab') {
    if (method === 'GET') return json(store.get('favorites'))
    if (method === 'PUT') {
      if (!isTrusted(request)) return forbidden()
      const list = sanitizeFavorites(await request.json().catch(() => null))
      if (!list) return json({ error: 'Invalid favorites' }, 400)
      store.set('favorites', list)
      return json(list)
    }
  }

  if (route[0] === 'history' && host === 'history') {
    const history = require('./history')
    if (method === 'GET' && !route[1]) {
      return json(
        history.list({
          search: url.searchParams.get('q') ?? '',
          offset: Number(url.searchParams.get('offset')) || 0,
          limit: Math.min(500, Number(url.searchParams.get('limit')) || 200),
        }),
      )
    }
    if (method === 'GET' && route[1] === 'settings') return json(history.getSettings())
    if (!isTrusted(request)) return forbidden()
    if (method === 'PUT' && route[1] === 'settings') {
      return json(history.setSettings(await request.json().catch(() => ({}))))
    }
    if (method === 'DELETE' && !route[1]) {
      history.remove(url.searchParams.get('url') ?? '')
      return json({ ok: true })
    }
    if (method === 'POST' && route[1] === 'clear') {
      const { clearBrowsingData } = require('./browsing-data')
      const body = await request.json().catch(() => ({}))
      return json(await clearBrowsingData(session.defaultSession, body))
    }
  }

  if (route[0] === 'passwords' && host === 'passwords') {
    const passwords = require('./passwords')
    if (!isTrusted(request) && method !== 'GET') return forbidden()
    if (method === 'GET') return json(passwords.listForPage())
    if (method === 'DELETE' && route[1] === 'never') {
      passwords.removeNever(url.searchParams.get('origin') ?? '')
      return json({ ok: true })
    }
    if (method === 'DELETE' && route[1]) {
      passwords.remove(route[1])
      return json({ ok: true })
    }
  }

  if (route[0] === 'extensions' && host === 'extensions') {
    const ses = session.defaultSession
    const id = route[1]
    if (method === 'GET' && !id) {
      return json(ses.extensions.getAllExtensions().map(extensionSummary))
    }
    if (method === 'GET' && id && route[2] === 'icon') {
      const ext = ses.extensions.getExtension(id)
      const iconPath = ext && extensionIconPath(ext)
      if (!iconPath || !fs.existsSync(iconPath)) return notFound()
      return net.fetch(pathToFileURL(iconPath).toString())
    }
    if (!isTrusted(request)) return forbidden()
    if (method === 'POST' && id && route[2] === 'options') {
      const ext = ses.extensions.getExtension(id)
      const page = ext?.manifest?.options_ui?.page ?? ext?.manifest?.options_page
      if (!page) return notFound()
      const { BrowserShell } = require('./shell')
      const shell = BrowserShell.lastFocused()
      shell?.createTab({ url: `chrome-extension://${id}/${page.replace(/^\//, '')}` })
      return json({ ok: true })
    }
    if (method === 'DELETE' && id) {
      const { uninstallExtension } = require('electron-chrome-web-store')
      try {
        await uninstallExtension(id, { session: ses })
      } catch {
        if (ses.extensions.getExtension(id)) ses.extensions.removeExtension(id)
      }
      return json({ ok: true })
    }
  }

  return notFound()
}

function serveFile(url) {
  const root = HOSTS[url.host]
  if (!root) return notFound()
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  const file = path.normalize(path.join(root, rel))
  if (!file.startsWith(root + path.sep)) return forbidden()
  if (!fs.existsSync(file)) return notFound()
  if (file.endsWith('.html')) {
    const html = fs
      .readFileSync(file, 'utf8')
      .replace('</head>', `<meta name="glasswing-token" content="${TOKEN}" /></head>`)
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
  }
  return net.fetch(pathToFileURL(file).toString())
}

function registerInternalProtocol(ses) {
  ses.protocol.handle(SCHEME, (request) => {
    let url
    try {
      url = new URL(request.url)
    } catch {
      return notFound()
    }
    if (url.pathname.startsWith('/api/')) return handleApi(request, url)
    return serveFile(url)
  })
}

module.exports = { registerInternalProtocol, fetchSuggestions }
