// Chrome's side panel for extensions (chrome.sidePanel), which the extensions library doesn't have. An
// extension's panel opens docked on the right of the window, beside the page, from its toolbar button or
// when it asks. It has a header with the extension's name and a close button, and its left edge resizes it.
const { WebContentsView, ipcMain } = require('electron')
const path = require('node:path')
const store = require('./store')

const DEFAULT_WIDTH = 400
const MIN_WIDTH = 280
const MAX_FRACTION = 0.6 // of the window
const HEADER_HEIGHT = 36
const GAP = 8
const BEHAVIOR_KEY = 'sidePanelBehavior' // { extensionId: openPanelOnActionClick }
const WIDTH_KEY = 'sidePanelWidth'

let ses = null
const options = new Map() // extensionId → { path, enabled, tabs: Map(tabId → { path, enabled }) }
const hookedWorkers = new WeakSet()

const extensionOf = (id) => (typeof id === 'string' ? ses?.extensions.getExtension(id) ?? null : null)
const defaultPath = (ext) => ext?.manifest?.side_panel?.default_path ?? null
const savedBehavior = () => store.get(BEHAVIOR_KEY) ?? {}

/** The panel an extension shows for a tab, after its own settings for that tab and overall. */
function effective(extensionId, tabId) {
  const ext = extensionOf(extensionId)
  const mine = options.get(extensionId)
  const forTab = tabId != null ? mine?.tabs.get(tabId) : null
  const pathValue = forTab?.path ?? mine?.path ?? defaultPath(ext)
  const enabled = forTab?.enabled ?? mine?.enabled ?? true
  return { path: pathValue, enabled: Boolean(enabled && pathValue) }
}

function urlFor(extensionId, panelPath) {
  if (!panelPath) return null
  try {
    const url = new URL(panelPath, `chrome-extension://${extensionId}/`)
    return url.protocol === 'chrome-extension:' && url.host === extensionId ? url.href : null
  } catch {
    return null
  }
}

function shellOfTab(tabId) {
  const { BrowserShell } = require('./shell')
  return [...BrowserShell.all].find((shell) => shell.tabs.has(tabId)) ?? null
}

function shellOfWindow(windowId) {
  const { BrowserShell } = require('./shell')
  return [...BrowserShell.all].find((shell) => !shell.win.isDestroyed() && shell.win.id === windowId) ?? null
}

function width(shell) {
  const [windowWidth] = shell.win.getContentSize()
  const saved = Number(store.get(WIDTH_KEY)) || DEFAULT_WIDTH
  return Math.round(Math.max(MIN_WIDTH, Math.min(saved, windowWidth * MAX_FRACTION)))
}

function open(shell, extensionId) {
  if (!shell || shell.closed || shell.private) return false
  const { path: panelPath, enabled } = effective(extensionId, shell.activeId)
  const url = enabled ? urlFor(extensionId, panelPath) : null
  if (!url) return false
  const current = shell.sidePanel
  if (current?.extensionId === extensionId) {
    if (current.url !== url) current.view.webContents.loadURL(url).catch(() => {})
    current.url = url
    return true
  }
  if (current) close(shell)

  const view = new WebContentsView({
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  view.setBorderRadius(shell.appearance?.radius ?? 10)
  view.setBackgroundColor('#ffffff')
  const wc = view.webContents
  // Links it opens become tabs in this window.
  wc.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.createTab({ url: target })
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, target) => {
    // The panel stays the extension's own page; a link to a website opens in a tab instead.
    if (!target.startsWith(`chrome-extension://${extensionId}/`)) {
      event.preventDefault()
      if (/^https?:/.test(target)) shell.createTab({ url: target })
    }
  })
  wc.on('before-input-event', (event, input) => {
    if (require('./shortcuts').handle(shell, input)) event.preventDefault()
  })
  wc.loadURL(url).catch(() => {})
  shell.win.contentView.addChildView(view)
  shell.win.contentView.addChildView(shell.ui) // the toolbar stays on top
  const ext = extensionOf(extensionId)
  shell.sidePanel = { extensionId, view, url, title: ext?.name ?? 'Extension' }
  shell.layout()
  shell.scheduleState()
  return true
}

function close(shell) {
  const panel = shell?.sidePanel
  if (!panel) return false
  shell.sidePanel = null
  if (!shell.win.isDestroyed()) shell.win.contentView.removeChildView(panel.view)
  if (!panel.view.webContents.isDestroyed()) panel.view.webContents.close()
  if (!shell.win.isDestroyed()) {
    shell.layout()
    shell.scheduleState()
  }
  return true
}

function toggle(shell, extensionId) {
  if (shell?.sidePanel?.extensionId === extensionId) return close(shell)
  return open(shell, extensionId)
}

/** Takes the panel's room off the right of the page area, places it, and says where it went for the backdrop to frame. */
function place(shell, card, radius) {
  const panel = shell.sidePanel
  if (!panel || panel.view.webContents.isDestroyed()) return null
  const panelWidth = Math.min(width(shell), Math.max(0, card.width - MIN_WIDTH))
  card.width = Math.max(0, card.width - panelWidth - GAP)
  const frame = { x: card.x + card.width + GAP, y: card.y, width: panelWidth, height: card.height }
  panel.view.setBorderRadius(radius)
  panel.view.setBounds({ x: frame.x, y: frame.y + HEADER_HEIGHT, width: frame.width, height: Math.max(0, frame.height - HEADER_HEIGHT) })
  return { frame, header: HEADER_HEIGHT, title: panel.title, edge: { x: frame.x - GAP, y: frame.y, width: GAP, height: frame.height } }
}

/** The left edge was dragged to `x`, in window coordinates. */
function resizeTo(shell, x) {
  const panel = shell?.sidePanel
  if (!panel || !Number.isFinite(x)) return
  const [windowWidth] = shell.win.getContentSize()
  const gap = shell.isChromeHidden() ? 0 : shell.appearance.gap
  const next = Math.round(Math.max(MIN_WIDTH, Math.min(windowWidth - gap - x - GAP / 2, windowWidth * MAX_FRACTION)))
  store.set(WIDTH_KEY, next)
  shell.layout()
}

/** Another tab is showing now: the panel follows what the extension wants for that tab. */
function tabChanged(shell) {
  const panel = shell?.sidePanel
  if (!panel) return
  const { path: panelPath, enabled } = effective(panel.extensionId, shell.activeId)
  const url = enabled ? urlFor(panel.extensionId, panelPath) : null
  if (!url) return close(shell)
  if (url !== panel.url) {
    panel.url = url
    panel.view.webContents.loadURL(url).catch(() => {})
  }
}

/**
 * Clicking an extension's toolbar button. True if that opened or closed its panel instead of anything else.
 * An extension that has a panel but never said what its button does gets the panel, since it has nothing else to show.
 */
function actionClicked(extensionId, tabId, hasPopup) {
  const ext = extensionOf(extensionId)
  if (!ext || !defaultPath(ext) && !options.get(extensionId)?.path) return false
  const said = savedBehavior()[extensionId]
  if (said === false || (said === undefined && hasPopup)) return false
  const shell = shellOfTab(tabId) ?? require('./shell').BrowserShell.lastNormal()
  toggle(shell, extensionId)
  return said === true
}

function cleanOptions(value) {
  const out = {}
  if (typeof value?.path === 'string') out.path = value.path
  if (typeof value?.enabled === 'boolean') out.enabled = value.enabled
  return out
}

/** chrome.sidePanel, as called by the extension `extensionId`. */
const methods = {
  setOptions(extensionId, arg) {
    const mine = options.get(extensionId) ?? { tabs: new Map() }
    options.set(extensionId, mine)
    const next = cleanOptions(arg)
    if (Number.isInteger(arg?.tabId)) mine.tabs.set(arg.tabId, { ...mine.tabs.get(arg.tabId), ...next })
    else Object.assign(mine, next)
    const { BrowserShell } = require('./shell')
    for (const shell of BrowserShell.all) if (shell.sidePanel?.extensionId === extensionId) tabChanged(shell)
  },
  getOptions(extensionId, arg) {
    const tabId = Number.isInteger(arg?.tabId) ? arg.tabId : undefined
    const { path: panelPath, enabled } = effective(extensionId, tabId)
    return { ...(tabId != null ? { tabId } : {}), ...(panelPath ? { path: panelPath } : {}), enabled }
  },
  setPanelBehavior(extensionId, arg) {
    if (typeof arg?.openPanelOnActionClick !== 'boolean') return
    store.set(BEHAVIOR_KEY, { ...savedBehavior(), [extensionId]: arg.openPanelOnActionClick })
  },
  getPanelBehavior(extensionId) {
    return { openPanelOnActionClick: savedBehavior()[extensionId] === true }
  },
  open(extensionId, arg) {
    const shell = Number.isInteger(arg?.tabId) ? shellOfTab(arg.tabId) : Number.isInteger(arg?.windowId) ? shellOfWindow(arg.windowId) : require('./shell').BrowserShell.lastNormal()
    if (!open(shell, extensionId)) throw new Error('No side panel to open')
  },
  close(extensionId, arg) {
    const { BrowserShell } = require('./shell')
    const shells = Number.isInteger(arg?.tabId) ? [shellOfTab(arg.tabId)] : Number.isInteger(arg?.windowId) ? [shellOfWindow(arg.windowId)] : [...BrowserShell.all]
    for (const shell of shells) if (shell?.sidePanel?.extensionId === extensionId) close(shell)
  },
}

async function call(extensionId, method, arg) {
  if (!extensionOf(extensionId) || !Object.hasOwn(methods, method)) throw new Error(`sidePanel.${method} isn't available`)
  return (await methods[method](extensionId, arg ?? {})) ?? undefined
}

const idFromUrl = (url) => (/^chrome-extension:\/\/([a-p]{32})\//.exec(url ?? '') ?? [])[1] ?? null

/** Registers the API for extension pages and service workers. Has to come before the extensions library, whose own preload freezes `chrome`. */
function setup(session) {
  ses = session
  session.registerPreloadScript({ id: 'glasswing-side-panel', type: 'frame', filePath: path.join(__dirname, '..', 'preload', 'side-panel.js') })
  session.registerPreloadScript({ id: 'glasswing-side-panel-worker', type: 'service-worker', filePath: path.join(__dirname, '..', 'preload', 'side-panel.js') })

  // Pages: only an extension's own page may speak for it.
  ipcMain.handle('side-panel:call', (event, method, arg) => {
    const extensionId = idFromUrl(event.senderFrame?.url)
    if (!extensionId) throw new Error('Not an extension')
    return call(extensionId, String(method), arg)
  })
  // Service workers send to their own channel; the extension is whose worker it is.
  session.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
    if (runningStatus !== 'starting') return
    const worker = session.serviceWorkers.getWorkerFromVersionID(versionId)
    const extensionId = idFromUrl(worker?.scope)
    if (!extensionId || hookedWorkers.has(worker)) return
    hookedWorkers.add(worker)
    worker.ipc.handle('side-panel:call', (_event, method, arg) => call(extensionId, String(method), arg))
  })
}

/** Wraps the library's toolbar button click so a panel can take it. */
function wrapActions(instance) {
  const actions = instance?.api?.browserAction
  if (!actions?.activateClick) return
  const original = actions.activateClick.bind(actions)
  actions.activateClick = (details) => {
    const { extensionId, tabId } = details ?? {}
    let hasPopup = false
    try {
      hasPopup = Boolean(actions.getPopupUrl(extensionId, tabId))
    } catch {}
    if (actionClicked(extensionId, tabId, hasPopup)) return
    return original(details)
  }
}

/** An extension was removed: its panels close and its settings go. */
function forget(extensionId) {
  const { BrowserShell } = require('./shell')
  for (const shell of BrowserShell.all) if (shell.sidePanel?.extensionId === extensionId) close(shell)
  options.delete(extensionId)
  const behavior = savedBehavior()
  if (extensionId in behavior) {
    delete behavior[extensionId]
    store.set(BEHAVIOR_KEY, behavior)
  }
}

module.exports = { setup, wrapActions, open, close, toggle, place, resizeTo, tabChanged, forget, call, actionClicked }
