// The search engine used by the address bar and the new tab page.
const store = require('./store')

const ENGINES = [
  { id: 'duckduckgo', name: 'DuckDuckGo', host: 'duckduckgo.com', path: '/', param: 'q', search: 'https://duckduckgo.com/?q=%s', suggest: 'https://duckduckgo.com/ac/?q=%s&type=list' },
  { id: 'google', name: 'Google', host: 'google.com', path: '/search', param: 'q', search: 'https://www.google.com/search?q=%s', suggest: 'https://www.google.com/complete/search?client=firefox&q=%s' },
  { id: 'bing', name: 'Bing', host: 'bing.com', path: '/search', param: 'q', search: 'https://www.bing.com/search?q=%s', suggest: 'https://api.bing.com/osjson.aspx?query=%s' },
  { id: 'brave', name: 'Brave Search', host: 'search.brave.com', path: '/search', param: 'q', search: 'https://search.brave.com/search?q=%s', suggest: 'https://search.brave.com/api/suggest?q=%s' },
]

function current() {
  return ENGINES.find((e) => e.id === store.get('searchEngine')) ?? ENGINES[0]
}

function set(id) {
  if (!ENGINES.some((e) => e.id === id)) return current()
  store.set('searchEngine', id)
  const { BrowserShell } = require('./shell')
  for (const shell of BrowserShell.all) shell.scheduleState()
  return current()
}

/** Which of our engines a search address belongs to, or null if it's one we don't offer. */
function idFromUrl(url) {
  // Chromium writes its built-in Google address with a placeholder for the country's domain.
  if (String(url).startsWith('{google:baseURL}')) return 'google'
  try {
    const labels = new URL(String(url).replace(/\{[^}]*\}/g, 'x')).hostname.split('.')
    return ENGINES.find((e) => labels.includes(e.id))?.id ?? null
  } catch {
    return null
  }
}

module.exports = { ENGINES, current, set, idFromUrl }
