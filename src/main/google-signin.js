// Google blocks sign-in from browsers it doesn't recognize as real Chrome ("This browser or app may
// not be secure"). Glasswing's user agent says Chrome, but the extra brand signals Chromium sends
// alongside it (Sec-CH-UA / navigator.userAgentData) don't include "Google Chrome", and Google
// flags the mismatch.
//
// The widely used workaround: present as Firefox on Google's sign-in pages only. Every other site
// keeps seeing Chrome.
//
// This changes each request rather than calling webContents.setUserAgent, because changing a tab's
// user agent mid-load reloads whatever page it's showing. That cancels the load in progress, so
// sign-in would fail, or the tab would land back on the page it came from.
const { ipcMain } = require('electron')
const path = require('node:path')

const SIGN_IN_HOSTS = new Set(['accounts.google.com'])
// Each request this looks at costs a trip through the main process, so it skips everyone but Google.
const GOOGLE_REQUESTS = ['*://*.google.com/*', '*://*.gstatic.com/*', '*://*.googleapis.com/*', '*://*.googleusercontent.com/*', '*://accounts.youtube.com/*']

function firefoxUserAgent() {
  // Firefox ships every 4 weeks; stay close to the current release so Google doesn't call it outdated.
  const version = 128 + Math.floor((Date.now() - Date.UTC(2024, 6, 9)) / (28 * 86_400_000)) - 1
  const platform = {
    darwin: 'Macintosh; Intel Mac OS X 10.15',
    win32: 'Windows NT 10.0; Win64; x64',
  }[process.platform] ?? 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platform}; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`
}

const FIREFOX_UA = firefoxUserAgent()

function isSignInUrl(url) {
  try {
    return SIGN_IN_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

/** A sign-in page, and whatever that page loads. Google embedded in another site stays as it is. */
function presentsAsFirefox({ resourceType, url, webContents }) {
  if (resourceType === 'mainFrame') return isSignInUrl(url)
  return Boolean(webContents) && !webContents.isDestroyed() && isSignInUrl(webContents.getURL())
}

function firefoxHeaders(headers) {
  const result = { 'User-Agent': FIREFOX_UA }
  for (const [name, value] of Object.entries(headers)) {
    if (!/^(user-agent$|sec-ch-ua)/i.test(name)) result[name] = value
  }
  return result
}

/** Applies the workaround to every tab and popup (e.g. "Sign in with Google" windows). */
function setupGoogleSignIn(session) {
  session.webRequest.onBeforeSendHeaders({ urls: GOOGLE_REQUESTS }, (details, callback) => {
    callback(presentsAsFirefox(details) ? { requestHeaders: firefoxHeaders(details.requestHeaders) } : {})
  })
  ipcMain.on('google-signin:user-agent', (event) => {
    event.returnValue = FIREFOX_UA
  })
  session.registerPreloadScript({
    id: 'glasswing-google-signin',
    type: 'frame',
    filePath: path.join(__dirname, '..', 'preload', 'google-signin.js'),
  })
}

module.exports = { setupGoogleSignIn, presentsAsFirefox, firefoxHeaders, FIREFOX_UA }
