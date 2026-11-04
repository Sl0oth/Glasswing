// The setup window: opens by itself on first launch, and from the ⋯ menu after that. Every choice in
// it takes effect straight away, so closing it part way keeps whatever was already picked.
const { BrowserWindow, ipcMain, nativeImage } = require('electron')
const path = require('node:path')
const { APP_NAME, TRANSPARENT } = require('./constants')
const appearance = require('./appearance')
const blocker = require('./blocker')
const browserImport = require('./browser-import')
const search = require('./search')
const store = require('./store')
const updater = require('./updater')

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png')

let win = null
let finished = null // resolves the promise from open()
let handlersReady = false

const needed = () => !store.get('onboarded')

function fullState() {
  const { ads, trackers } = blocker.getSettings()
  return {
    version: require('electron').app.getVersion(),
    firstRun: needed(),
    icon: nativeImage.createFromPath(ICON_PATH).toDataURL(),
    appearance: appearance.get(),
    presets: appearance.PRESETS,
    accents: appearance.ACCENTS,
    engines: search.ENGINES.map(({ id, name }) => ({ id, name })),
    engine: search.current().id,
    protection: { ads, trackers },
    updates: updater.getMode(),
    browsers: browserImport.detect(),
  }
}

function setupHandlers() {
  if (handlersReady) return
  handlersReady = true
  const handle = (channel, run) =>
    ipcMain.handle(`setup:${channel}`, (event, ...args) => {
      if (!win || win.isDestroyed() || event.sender !== win.webContents) throw new Error('Unknown sender')
      return run(...args)
    })

  handle('state', fullState)
  handle('appearance', (partial) => {
    const next = appearance.update(partial)
    if (partial?.material && process.platform === 'win32') win.setBackgroundMaterial(next.material)
    return next
  })
  handle('search', (id) => search.set(id).id)
  handle('protection', (settings) => {
    blocker.set(settings)
    return blocker.getSettings()
  })
  handle('updates', (mode) => updater.setMode(mode))
  handle('import', (browserId, profile, what) => browserImport.run(browserId, profile, what))
  handle('finish', () => win.close())
}

/** Opens the window, or brings it forward. Resolves once it has been closed. */
function open() {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return Promise.resolve()
  }
  setupHandlers()
  const current = appearance.get()
  win = new BrowserWindow({
    width: 760,
    height: 580,
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    show: false,
    title: `Welcome to ${APP_NAME}`,
    icon: ICON_PATH,
    titleBarStyle: 'hidden',
    backgroundColor: process.platform === 'linux' ? '#161618' : TRANSPARENT,
    ...(process.platform === 'win32' && { backgroundMaterial: current.material }),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'setup.js'),
      sandbox: true,
      contextIsolation: true,
      spellcheck: false,
    },
  })
  win.setMenu(null)
  win.once('ready-to-show', () => win.show())
  // In case the page is slow for some reason: an invisible first launch looks like nothing happened.
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show()
  }, 3000)
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const closed = new Promise((resolve) => (finished = resolve))
  win.on('closed', () => {
    win = null
    // Closing it counts: nobody should be asked again on every launch.
    store.set('onboarded', true)
    store.flush()
    finished?.()
    finished = null
  })
  win.loadURL('glasswing://ui/setup.html').catch((err) => console.error('Setup window failed to load:', err))
  return closed
}

function focus() {
  if (!win || win.isDestroyed()) return false
  win.show()
  win.focus()
  return true
}

module.exports = { needed, open, focus }
