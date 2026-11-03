// Google blocks sign-in from browsers it doesn't recognize as real Chrome ("This browser or app may
// not be secure"). Glasswing's user agent says Chrome, but the extra brand signals Chromium sends
// alongside it (Sec-CH-UA / navigator.userAgentData) don't include "Google Chrome", and Google
// flags the mismatch.
//
// The widely used workaround: present as Firefox on Google's sign-in pages only. Overriding the
// user agent per tab also drops those brand signals, so the page sees a consistent Firefox. Every
// other site keeps seeing Chrome.
const { app } = require('electron')
const path = require('node:path')

const SIGN_IN_HOSTS = new Set(['accounts.google.com'])

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

function attach(webContents) {
  let firefox = false

  const use = (wantFirefox) => {
    if (wantFirefox === firefox) return false
    firefox = wantFirefox
    webContents.setUserAgent(wantFirefox ? FIREFOX_UA : app.userAgentFallback)
    return true
  }

  // Entering sign-in: the user agent has to be right for the very first request, so switch and
  // restart the navigation. Leaving sign-in: just switch back.
  webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    const wantFirefox = isSignInUrl(details.url)
    // loadURL replaces the navigation that's already underway.
    if (use(wantFirefox) && wantFirefox) webContents.loadURL(details.url).catch(() => {})
  })

  webContents.on('will-redirect', (details) => {
    if (!details.isMainFrame) return
    const wantFirefox = isSignInUrl(details.url)
    if (use(wantFirefox) && wantFirefox) {
      details.preventDefault()
      webContents.loadURL(details.url).catch(() => {})
    }
  })
}

/** Applies the workaround to every tab and popup (e.g. "Sign in with Google" windows). */
function setupGoogleSignIn(session) {
  app.on('web-contents-created', (_event, webContents) => attach(webContents))
  session.registerPreloadScript({
    id: 'glasswing-google-signin',
    type: 'frame',
    filePath: path.join(__dirname, '..', 'preload', 'google-signin.js'),
  })
}

module.exports = { setupGoogleSignIn, FIREFOX_UA }
