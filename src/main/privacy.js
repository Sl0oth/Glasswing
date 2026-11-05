// Protections that apply to every page, on top of ad and tracker blocking. The shield's per-site
// exceptions turn the address rewriting off for a site that breaks (see pageRedirect in blocker.js).
const { app } = require('electron')

// Only tags that exist to follow you between sites. Generic names like `ref` or `id` stay: sites use those.
const TRACKING_TAG = /^(utm_[a-z_]+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|mc_eid|mc_cid|igshid|igsh|twclid|ttclid|yclid|_hsenc|_hsmi|mkt_tok|vero_id|oly_anon_id|oly_enc_id|rb_clickid|srsltid)$/i

// Names that only mean something on your own network, where a secure version rarely exists.
const LOCAL_HOST = /(^\[|^\d{1,3}(\.\d{1,3}){3}$|\.(local|localhost|internal|intranet|lan|home|corp)$|^[^.]+$)/i

const upgraded = new Set() // hosts sent to https that haven't loaded yet
const plainOnly = new Set() // hosts whose secure version failed: not tried again until restart

/** Edits the text rather than re-encoding the address, so everything else in it stays exactly as it was. */
function withoutTrackingTags(url) {
  const match = /^([^?#]*)\?([^#]*)(#.*)?$/.exec(url)
  if (!match) return url
  const [, base, query, hash = ''] = match
  const kept = query.split('&').filter((part) => !TRACKING_TAG.test(part.split('=')[0]))
  return `${base}${kept.length ? `?${kept.join('&')}` : ''}${hash}`
}

function withHttps(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  // A port means someone chose it on purpose, and https wouldn't be on the same one.
  if (parsed.protocol !== 'http:' || parsed.port || LOCAL_HOST.test(parsed.hostname) || plainOnly.has(parsed.hostname)) return url
  upgraded.add(parsed.hostname)
  return `https://${url.slice('http://'.length)}`
}

/** The address a page should really load from, or null if the one it has is fine. */
function saferUrl(url, { stripTrackers = true } = {}) {
  if (!/^https?:\/\//.test(url)) return null
  const next = withHttps(stripTrackers ? withoutTrackingTags(url) : url)
  return next === url ? null : next
}

/** After a failed load: the plain address to try if the failure was on a site we moved to https. */
function fallbackFor(url) {
  try {
    const { hostname, protocol } = new URL(url)
    if (protocol !== 'https:' || !upgraded.delete(hostname)) return null
    plainOnly.add(hostname)
    return `http://${url.slice('https://'.length)}`
  } catch {
    return null
  }
}

/** The secure version loaded, so a later failure there is just a failure. */
function loaded(url) {
  try {
    upgraded.delete(new URL(url).hostname)
  } catch {
    // Not an address with a host.
  }
}

// Non-profit Quad9 first, then Cloudflare. Neither is Google, and neither is run by your network.
const SECURE_DNS_SERVERS = ['https://dns.quad9.net/dns-query', 'https://cloudflare-dns.com/dns-query']

/**
 * Looks up site names over an encrypted connection, so your network can't read them from the lookups.
 * "Automatic" falls back to normal lookups when these servers can't be reached, as on some school
 * networks, so sites don't stop loading. Your network can still see which servers you connect to.
 */
function applySecureDns(on) {
  app.configureHostResolver({ secureDnsMode: on ? 'automatic' : 'off', secureDnsServers: SECURE_DNS_SERVERS })
}

/** Keeps websites from reading your computer's address on your own network through WebRTC. Calls still work. */
function setupPrivacy() {
  app.on('web-contents-created', (_event, webContents) => {
    webContents.setWebRTCIPHandlingPolicy('default_public_interface_only')
  })
}

module.exports = { setupPrivacy, applySecureDns, saferUrl, fallbackFor, loaded }
