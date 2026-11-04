// Google refuses sign-in ("This browser or app may not be secure") from a browser that says it's stock
// Chrome or Firefox but doesn't behave exactly like one. Glasswing looks like plain Chrome to other
// sites (see chromeUserAgent in index.js), so on Google's sign-in pages it says what it really is, and
// Google serves the sign-in it has for that. Google doesn't document this check, so it may change.
//
// This changes each request rather than calling webContents.setUserAgent, because changing a tab's
// user agent mid-load reloads whatever page it's showing. That cancels the load in progress, so
// sign-in would fail, or the tab would land back on the page it came from.
const { app } = require('electron')
const path = require('node:path')

const SIGN_IN_HOSTS = new Set(['accounts.google.com'])
// Each request this looks at costs a trip through the main process, so it skips everyone but Google.
const GOOGLE_REQUESTS = ['*://*.google.com/*', '*://*.gstatic.com/*', '*://*.googleapis.com/*', '*://*.googleusercontent.com/*', '*://accounts.youtube.com/*']

/** The same as signInUserAgent() in src/preload/google-signin.js; the smoke test checks that they match. */
function signInUserAgent() {
  return app.userAgentFallback.replace(/Chrome\/[\d.]+ Safari/, `Chrome/${process.versions.chrome} Electron/${process.versions.electron} Safari`)
}

function isSignInUrl(url) {
  try {
    return SIGN_IN_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

/** A sign-in page, and whatever that page loads. Google embedded in another site stays as it is. */
function usesSignInIdentity({ resourceType, url, webContents }) {
  if (resourceType === 'mainFrame') return isSignInUrl(url)
  return Boolean(webContents) && !webContents.isDestroyed() && isSignInUrl(webContents.getURL())
}

function signInHeaders(headers) {
  const result = { 'User-Agent': signInUserAgent() }
  for (const [name, value] of Object.entries(headers)) {
    if (!/^user-agent$/i.test(name)) result[name] = value
  }
  return result
}

/** Applies to every tab and popup (e.g. "Sign in with Google" windows). */
function setupGoogleSignIn(session) {
  session.webRequest.onBeforeSendHeaders({ urls: GOOGLE_REQUESTS }, (details, callback) => {
    callback(usesSignInIdentity(details) ? { requestHeaders: signInHeaders(details.requestHeaders) } : {})
  })
  session.registerPreloadScript({
    id: 'glasswing-google-signin',
    type: 'frame',
    filePath: path.join(__dirname, '..', 'preload', 'google-signin.js'),
  })
}

module.exports = { setupGoogleSignIn, usesSignInIdentity, signInHeaders, signInUserAgent }
