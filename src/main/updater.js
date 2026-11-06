// Looks for new releases on GitHub. By default one downloads quietly and then asks before restarting;
// the setting can make it ask before downloading too. Anything downloaded is also installed the next
// time you quit, so saying "Later" never loses an update.
const { app, nativeImage } = require('electron')
const path = require('node:path')
const store = require('./store')
const prompts = require('./prompts')

const appIcon = () => nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png'))

const FIRST_CHECK_DELAY_MS = 20_000
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

let updater = null
let started = false
let manualShell = null // a window that asked to check, and so wants to hear the answer either way
let offeredVersion = null
let readyVersion = null
let downloading = false

function getMode() {
  return store.get('updates')?.mode === 'ask' ? 'ask' : 'auto'
}

function setMode(mode) {
  store.set('updates', { mode: mode === 'ask' ? 'ask' : 'auto' })
  return getMode()
}

function currentShell() {
  const { BrowserShell } = require('./shell')
  return BrowserShell.lastFocused()
}

function download() {
  if (downloading || readyVersion) return
  downloading = true
  updater.downloadUpdate().catch((err) => {
    downloading = false
    failed(err)
  })
}

function failed(err) {
  console.error('Update problem:', err?.message ?? err)
  const shell = manualShell
  manualShell = null
  if (!shell) return // an update check that fails on its own isn't worth interrupting anyone over
  prompts.ask(shell, {
    title: 'Couldn’t check for updates',
    message: 'Glasswing couldn’t reach its update server. It’ll try again later.',
    buttons: [{ id: 'ok', label: 'OK', style: 'primary' }],
    cancelId: 'ok',
  })
}

async function offerRestart(shell = currentShell()) {
  const { button } = await prompts.ask(shell, {
    icon: appIcon(),
    title: `Glasswing ${readyVersion} is ready`,
    message: 'Restart to update. Your tabs will come back.',
    buttons: [
      { id: 'later', label: 'Later', style: 'secondary' },
      { id: 'restart', label: 'Restart', style: 'primary' },
    ],
    cancelId: 'later',
  })
  if (button === 'restart') updater.quitAndInstall(true, true)
}

async function offerDownload(version, shell = currentShell()) {
  const { button } = await prompts.ask(shell, {
    icon: appIcon(),
    title: `Glasswing ${version} is available`,
    message: 'Do you want to download it now?',
    buttons: [
      { id: 'later', label: 'Later', style: 'secondary' },
      { id: 'download', label: 'Download', style: 'primary' },
    ],
    cancelId: 'later',
  })
  if (button === 'download') download()
}

function check() {
  if (!updater || readyVersion || downloading) return
  updater.checkForUpdates().catch(failed)
}

/** "Check for Updates…" in the ⋯ menu. */
function checkNow(shell) {
  if (readyVersion) return offerRestart(shell)
  if (!updater) {
    return prompts.ask(shell, {
      title: 'Updates aren’t available here',
      message: `This copy of Glasswing (${app.getVersion()}) is running from source, so it doesn’t update itself.`,
      buttons: [{ id: 'ok', label: 'OK', style: 'primary' }],
      cancelId: 'ok',
    })
  }
  if (downloading) {
    return prompts.ask(shell, {
      title: 'Downloading an update',
      message: 'You’ll be asked to restart when it’s ready.',
      buttons: [{ id: 'ok', label: 'OK', style: 'primary' }],
      cancelId: 'ok',
    })
  }
  manualShell = shell
  check()
}

function start() {
  if (started || !app.isPackaged) return
  started = true
  const { autoUpdater } = require('electron-updater')
  updater = autoUpdater
  updater.autoDownload = false // decided below, according to the setting
  updater.autoInstallOnAppQuit = true
  updater.logger = null
  // For testing a build against a local copy of a release, without publishing anything.
  if (process.env.GLASSWING_UPDATE_FEED) updater.setFeedURL({ provider: 'generic', url: process.env.GLASSWING_UPDATE_FEED })

  updater.on('update-available', ({ version }) => {
    const shell = manualShell
    manualShell = null
    if (getMode() === 'auto') return download()
    // Once per run is enough, unless asked. The next launch offers it again.
    if (shell || offeredVersion !== version) {
      offeredVersion = version
      offerDownload(version, shell ?? currentShell())
    }
  })
  updater.on('update-not-available', () => {
    const shell = manualShell
    manualShell = null
    if (!shell) return
    prompts.ask(shell, {
      title: 'You’re up to date',
      message: `Glasswing ${app.getVersion()} is the newest version.`,
      buttons: [{ id: 'ok', label: 'OK', style: 'primary' }],
      cancelId: 'ok',
    })
  })
  updater.on('update-downloaded', ({ version }) => {
    downloading = false
    readyVersion = version
    offerRestart()
  })
  updater.on('error', failed)

  setTimeout(check, Number(process.env.GLASSWING_UPDATE_DELAY_MS) || FIRST_CHECK_DELAY_MS)
  setInterval(check, CHECK_EVERY_MS)
}

module.exports = { start, checkNow, getMode, setMode }
