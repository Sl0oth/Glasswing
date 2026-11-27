// Being the browser other apps open links in. On a Mac you choose it in ⋯ → Settings, and macOS asks you to
// confirm. The app says it can open web links and web pages in its Info.plist (see "extendInfo" in
// package.json), which is what lets macOS list it as a browser at all.
//
// Links and pages that macOS sends arrive through `open-url` and `open-file`, often before any window is open,
// so they wait in `pending` until startup takes them.
//
// Setup suggests it, and so does one message a day or more later, once. After that it's only in Settings.
const { app } = require('electron')
const { pathToFileURL } = require('node:url')

const supported = process.platform === 'darwin'
const CACHE_MS = 2000
const SUGGEST_AFTER_MS = 24 * 60 * 60 * 1000
const SUGGEST_DELAY_MS = 60_000 // not the moment you open it: let you get going first
let cached = false
let cachedAt = 0
let pending = []
let deliver = null // once the browser's open: opens links as they come

function isDefault() {
  if (!supported) return false
  if (Date.now() - cachedAt > CACHE_MS) {
    cached = app.isDefaultProtocolClient('http')
    cachedAt = Date.now()
  }
  return cached
}

/** macOS asks you to confirm, in its own window, so whether it worked is only known later. */
function makeDefault() {
  if (!supported) return
  app.setAsDefaultProtocolClient('http')
  app.setAsDefaultProtocolClient('https')
  refresh()
}

function refresh() {
  cachedAt = 0
}

function receive(url) {
  if (deliver) deliver([url])
  else pending.push(url)
}

/** Call before the app is ready: macOS can send the link that launched Glasswing straight away. */
function listen() {
  if (!supported) return
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) receive(url)
  })
  app.on('open-file', (event, file) => {
    event.preventDefault()
    if (/\.(html?|xhtml|svg|pdf|txt)$/i.test(file)) receive(pathToFileURL(file).href)
  })
}

/** Hands over what arrived during startup, and from then on passes new links straight to `open`. */
function takePending(open) {
  const waiting = pending
  pending = []
  deliver = open
  return waiting
}

/** The one later reminder. Call once the browser's windows are open. */
function suggestLater() {
  const store = require('./store')
  if (!supported || store.get('defaultBrowserSuggested')) return
  const since = store.get('defaultBrowserSuggestFrom')
  if (!since) return store.set('defaultBrowserSuggestFrom', Date.now()) // the day counts from here
  if (Date.now() - since < SUGGEST_AFTER_MS) return
  setTimeout(async () => {
    refresh()
    if (isDefault()) return store.set('defaultBrowserSuggested', true)
    const { BrowserShell } = require('./shell')
    const shell = BrowserShell.lastNormal()
    if (!shell) return
    store.set('defaultBrowserSuggested', true) // asked is asked, whatever the answer
    const { button } = await require('./prompts').ask(shell, {
      title: 'Make Glasswing your default browser?',
      message: 'Links you open in Mail, Messages and other apps will open here. You can change it any time in ⋯ → Settings.',
      buttons: [
        { id: 'later', label: 'Not Now', style: 'secondary' },
        { id: 'default', label: 'Make Default', style: 'primary' },
      ],
      cancelId: 'later',
    })
    if (button === 'default') makeDefault()
  }, SUGGEST_DELAY_MS).unref?.()
}

module.exports = { supported, isDefault, makeDefault, refresh, listen, takePending, suggestLater }
