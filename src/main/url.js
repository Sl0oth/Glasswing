const { SEARCH_URL, SCHEME, NEWTAB_URL, EXTENSIONS_URL, HISTORY_URL, PASSWORDS_URL } = require('./constants')

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i
const BARE_SCHEME_RE = /^(about|data|mailto|view-source|javascript):/i
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?([/?#].*)?$/
const LOCALHOST_RE = /^localhost(:\d+)?([/?#].*)?$/i
const DOMAIN_RE = /^[^\s/?#:]+\.[a-z][a-z0-9-]{1,62}(:\d+)?([/?#].*)?$/i

const ALIASES = {
  'chrome://extensions': EXTENSIONS_URL,
  'chrome://history': HISTORY_URL,
  'about:history': HISTORY_URL,
  'chrome://password-manager': PASSWORDS_URL,
  'chrome://newtab': NEWTAB_URL,
  'about:newtab': NEWTAB_URL,
  'about:home': NEWTAB_URL,
}

function searchUrl(query) {
  return SEARCH_URL.replace('%s', encodeURIComponent(query))
}

/** Turns whatever was typed into the address bar into a URL. */
function resolveInput(input) {
  const text = String(input ?? '').trim()
  if (!text) return null

  const alias = ALIASES[text.toLowerCase().replace(/\/$/, '')]
  if (alias) return alias

  if (/\s/.test(text)) return searchUrl(text)
  if (SCHEME_RE.test(text)) return text
  if (BARE_SCHEME_RE.test(text) && !/^javascript:/i.test(text)) return text
  if (LOCALHOST_RE.test(text) || IPV4_RE.test(text)) return `http://${text}`
  if (DOMAIN_RE.test(text)) return `https://${text}`
  return searchUrl(text)
}

function isInternal(url) {
  return typeof url === 'string' && url.startsWith(`${SCHEME}:`)
}

function isNewTab(url) {
  return !url || url === NEWTAB_URL || url === NEWTAB_URL.slice(0, -1)
}

module.exports = { resolveInput, searchUrl, isInternal, isNewTab }
