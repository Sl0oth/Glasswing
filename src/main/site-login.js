// The username and password box some sites and networks ask for themselves (HTTP authentication, and
// proxies like a school's). Electron cancels these unless something answers, so those sites just fail.
const { app } = require('electron')
const prompts = require('./prompts')

function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** A page's own requests may ask. An image or frame from another site can't, because that's a classic way to fake a login. */
function mayAsk(webContents, details, authInfo) {
  if (authInfo.isProxy || details.isMainFrame) return true
  return Boolean(webContents) && !webContents.isDestroyed() && originOf(webContents.getURL()) === originOf(details.url)
}

function describe(details, authInfo) {
  const place = authInfo.isProxy ? `The proxy ${authInfo.host}` : authInfo.host
  const unsafe = !authInfo.isProxy && !String(details.url).startsWith('https:')
  const lines = []
  if (!details.firstAuthAttempt) lines.push('That didn’t work. Check them and try again.')
  if (authInfo.realm) lines.push(`It says: ${authInfo.realm}`)
  if (unsafe) lines.push('This connection isn’t encrypted, so others on the network could read what you type.')
  return { message: `${place} wants a username and password.`, detail: lines.join('\n') }
}

function setupSiteLogin() {
  app.on('login', async (event, webContents, details, authInfo, callback) => {
    event.preventDefault()
    const { BrowserShell } = require('./shell')
    const shell = BrowserShell.fromWebContents(webContents) ?? BrowserShell.lastFocused()
    if (!shell || !mayAsk(webContents, details, authInfo)) return callback()

    const { button, values } = await prompts.ask(shell, {
      title: 'Sign in',
      ...describe(details, authInfo),
      fields: [
        { id: 'username', label: 'Username' },
        { id: 'password', label: 'Password', type: 'password' },
      ],
      buttons: [
        { id: 'cancel', label: 'Cancel', style: 'secondary' },
        { id: 'signin', label: 'Sign In', style: 'primary' },
      ],
      cancelId: 'cancel',
    })
    if (button === 'signin') callback(String(values.username ?? ''), String(values.password ?? ''))
    else callback()
  })
}

module.exports = { setupSiteLogin }
