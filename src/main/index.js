const { app, protocol, session, nativeTheme, Menu, webContents } = require('electron')
const prompts = require('./prompts')
const { installChromeWebStore } = require('electron-chrome-web-store')
const { APP_ID, APP_NAME, SCHEME } = require('./constants')
const { registerInternalProtocol } = require('./protocol')
const { setupPermissions } = require('./permissions')
const { setupDownloads } = require('./downloads')
const { setupIpc } = require('./ipc')
const { BrowserShell } = require('./shell')
const { applicationMenu } = require('./menus')
const { setupPasswords } = require('./passwords')
const { setupGoogleSignIn } = require('./google-signin')
const { restoreSessionCookies, flushAll } = require('./persistence')
const extensions = require('./extensions')
const blocker = require('./blocker')
const { setupPrivacy } = require('./privacy')
const { setupSiteLogin } = require('./site-login')
const setup = require('./setup')
const updater = require('./updater')
const store = require('./store')
const path = require('node:path')
const fs = require('node:fs')

// Lets a test run an installed copy against a throwaway profile, even after it restarts itself to update.
if (process.env.GLASSWING_PROFILE) app.setPath('userData', process.env.GLASSWING_PROFILE)

let starting = true // until the first browser window is open

/**
 * Present as plain Chrome. Electron's default user agent advertises "Electron/x" and the app
 * name, which makes sites (Google sign-in, the Web Store, ...) treat us as an unsupported browser.
 */
function chromeUserAgent() {
  const major = process.versions.chrome.split('.')[0]
  const platform = {
    darwin: 'Macintosh; Intel Mac OS X 10_15_7',
    win32: 'Windows NT 10.0; Win64; x64',
  }[process.platform] ?? 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

function urlsFromArgv(argv) {
  return argv.slice(1).filter((arg) => /^https?:\/\//i.test(arg))
}

async function confirmExtensionInstall({ localizedName, manifest, icon, frame }) {
  const sender = frame && !frame.isDestroyed() ? webContents.fromFrame(frame) : null
  const shell = BrowserShell.fromWebContents(sender) ?? BrowserShell.lastFocused()
  const permissions = [...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])]
    .filter((p) => typeof p === 'string')
  const listed = permissions.slice(0, 8)
  if (permissions.length > 8) listed.push(`and ${permissions.length - 8} more`)

  const { button } = await prompts.ask(shell, {
    icon,
    title: `Add “${localizedName}”?`,
    message: permissions.length ? 'It will be able to use:' : 'It doesn’t request any special permissions.',
    detail: listed.join('\n'),
    buttons: [
      { id: 'cancel', label: 'Cancel', style: 'secondary' },
      { id: 'add', label: 'Add Extension', style: 'primary' },
    ],
    cancelId: 'cancel',
  })
  return { action: button === 'add' ? 'allow' : 'deny' }
}

/**
 * Chromium's final shutdown sometimes hangs after everything is saved and every helper process has
 * exited (seen when a Google sign-in page was open). A hung process would also keep the
 * single-instance lock, so launching Glasswing again would silently do nothing. A detached helper
 * ends this process if it's still alive after `ms`.
 */
function startExitWatchdog(ms) {
  const { spawn } = require('node:child_process')
  const script = `setTimeout(() => { try { process.kill(${process.pid}) } catch {} }, ${ms})`
  const helper = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  helper.on('error', (err) => logError('Exit watchdog failed to start', err))
  helper.unref()
}

/** Problems go to glasswing.log in the profile folder instead of a native error dialog. */
function logError(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind}: ${err?.stack ?? err}\n`
  console.error(line)
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'glasswing.log'), line)
  } catch {}
}

function restoreWindows(extraUrls) {
  const saved = store.get('session')?.windows?.filter((w) => w.tabs?.length) ?? []
  if (saved.length === 0) {
    BrowserShell.create({ urls: extraUrls })
    return
  }
  saved.forEach((w, i) => {
    const tabs = i === saved.length - 1 ? [...w.tabs, ...extraUrls.map((url) => ({ url }))] : w.tabs
    const activeIndex = extraUrls.length && i === saved.length - 1 ? tabs.length - 1 : w.active
    BrowserShell.create({ tabs, activeIndex, bounds: w.bounds, maximized: w.maximized, splits: w.splits })
  })
}

async function start() {
  Menu.setApplicationMenu(applicationMenu())

  const ses = session.defaultSession
  registerInternalProtocol(ses)
  setupPermissions(ses)
  setupDownloads(ses)
  setupPasswords()
  setupGoogleSignIn(ses)
  setupIpc()
  extensions.init(ses)
  ses.registerPreloadScript({
    id: 'glasswing-autofill',
    type: 'frame',
    filePath: path.join(__dirname, '..', 'preload', 'autofill.js'),
  })
  ses.registerPreloadScript({
    id: 'glasswing-capture',
    type: 'frame',
    filePath: path.join(__dirname, '..', 'preload', 'capture.js'),
  })
  setupPrivacy()
  setupSiteLogin()
  // None of these is worth failing to open a window over.
  await blocker.init(ses).catch((err) => logError('Could not start ad and tracker blocking', err))
  // The rest of startup can carry on behind it, but no browser window opens until it's done with.
  const setupDone = setup.needed() ? setup.open() : Promise.resolve()
  await restoreSessionCookies(ses).catch((err) => logError('Could not restore session cookies', err))
  try {
    // Lets the Chrome Web Store's "Add to Chrome" button install into this browser, loads
    // previously installed extensions, and keeps them updated.
    await installChromeWebStore({ session: ses, beforeInstall: confirmExtensionInstall })
  } catch (err) {
    logError('Chrome Web Store support failed to initialize', err)
  }

  await setupDone

  try {
    restoreWindows(urlsFromArgv(process.argv))
  } catch (err) {
    // A damaged saved session shouldn't stop the browser from opening.
    logError('Could not restore the last session', err)
    if (BrowserShell.all.size === 0) BrowserShell.create()
  }
  starting = false
  updater.start()
}

// ── Bootstrap ──────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => logError('Uncaught exception', err))
process.on('unhandledRejection', (err) => logError('Unhandled rejection', err))

app.setName(APP_NAME)
if (process.platform === 'win32') app.setAppUserModelId(APP_ID) // must match the installer's shortcuts
app.userAgentFallback = chromeUserAgent()
nativeTheme.themeSource = 'dark'

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (setup.focus() && starting) return
    const urls = urlsFromArgv(argv)
    const shell = BrowserShell.lastNormal()
    if (!shell) return BrowserShell.create({ urls })
    for (const url of urls) shell.createTab({ url })
    shell.focus()
  })

  app.on('window-all-closed', () => {
    if (starting) return // the setup window closed, and the browser's about to open
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (app.isReady() && BrowserShell.all.size === 0) BrowserShell.create()
  })

  let flushed = false
  app.on('before-quit', (event) => {
    if (BrowserShell.all.size > 0) BrowserShell.saveSession()
    BrowserShell.quitting = true
    if (!flushed && require('./history').getSettings().clearOnExit) require('./history').clear(0)
    store.flush()
    if (flushed || !app.isReady()) return
    // Make sure cookies and site storage are on disk before exiting.
    event.preventDefault()
    flushAll(session.defaultSession).finally(() => {
      flushed = true
      store.flush()
      startExitWatchdog(3000)
      app.quit()
    })
  })

  app.whenReady().then(start).catch((err) => {
    logError('Startup failed', err)
    starting = false
    if (BrowserShell.all.size === 0) BrowserShell.create()
  })
}
