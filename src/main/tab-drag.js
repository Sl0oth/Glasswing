// A tab pulled out of the tab strip. The toolbar UI says when the drag starts and ends; everything
// in between happens here, because only the main process can see across windows.
//
// Where the tab can land:
//   - another Glasswing window: the tab moves there
//   - this window: left and right offer split view, the middle offers a new window
//   - nothing (outside every window): a new window
const { BrowserWindow, screen } = require('electron')

const TICK_MS = 16
const GHOST = { width: 240, height: 40, offsetX: 14, offsetY: 12 }

let drag = null

function shellUnderCursor(BrowserShell, cursor) {
  for (const shell of BrowserShell.recent) {
    if (shell.closed || shell.win.isDestroyed() || !shell.win.isVisible() || shell.win.isMinimized()) continue
    const b = shell.win.getContentBounds()
    if (cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height) return shell
  }
  return null
}

function landingFor(cursor) {
  const { source, tab } = drag
  const multiple = source.order.length > 1
  const target = shellUnderCursor(source.constructor, cursor)

  if (!target) return multiple ? { kind: 'new-window' } : { kind: 'none' }
  if (target.private !== source.private) return { kind: 'none' } // a page can't change sides, private or not
  if (target !== source) return { kind: 'merge', target }
  if (!multiple) return { kind: 'none' }

  const b = source.win.getContentBounds()
  const third = (cursor.x - b.x) / b.width
  const partnerId = source.splitPartnerFor(tab.id)
  if (third < 1 / 3 && partnerId != null) return { kind: 'split', side: 'left', partnerId, offer: true }
  if (third > 2 / 3 && partnerId != null) return { kind: 'split', side: 'right', partnerId, offer: true }
  return { kind: 'new-window', offer: true }
}

const zoneName = (landing) => (landing.kind === 'split' ? landing.side : landing.kind === 'new-window' ? 'center' : null)

function setHoverTarget(target, cursor) {
  if (drag.hover && drag.hover !== target) drag.hover.setDropHover(null)
  drag.hover = target
  if (target) {
    const b = target.win.getContentBounds()
    target.setDropHover(cursor.x - b.x)
  }
}

function tick() {
  if (!drag) return
  if (drag.source.closed || !drag.source.tabs.has(drag.tab.id)) return cancel()
  const cursor = screen.getCursorScreenPoint()
  if (drag.ghost && !drag.ghost.isDestroyed()) {
    drag.ghost.setPosition(Math.round(cursor.x + GHOST.offsetX), Math.round(cursor.y + GHOST.offsetY))
  }

  drag.landing = landingFor(cursor)
  drag.cursor = cursor
  setHoverTarget(drag.landing.kind === 'merge' ? drag.landing.target : null, cursor)

  const key = `${drag.landing.offer ? 'offer' : 'none'} ${zoneName(drag.landing)}`
  if (key === drag.lastKey) return
  drag.lastKey = key
  drag.source.sendEvent('tab-drag-zone', { offer: Boolean(drag.landing.offer), zone: zoneName(drag.landing) })
}

/** The small label that follows the pointer, which can travel outside the window it came from. */
function createGhost(tab) {
  const ghost = new BrowserWindow({
    width: GHOST.width,
    height: GHOST.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { session: tab.shell.session, sandbox: true, contextIsolation: true }, // it shows the tab's icon
  })
  ghost.setAlwaysOnTop(true, 'pop-up-menu')
  ghost.setIgnoreMouseEvents(true)
  const data = JSON.stringify({ title: tab.title, favicon: tab.favicon })
  ghost.webContents.once('did-finish-load', () => {
    if (ghost.isDestroyed()) return
    ghost.webContents.executeJavaScript(`window.setTab(${data})`).catch(() => {})
    ghost.showInactive()
  })
  ghost.webContents.loadURL('glasswing://ui/ghost.html').catch(() => {})
  return ghost
}

function start(source, id) {
  const tab = source.tabs.get(id)
  if (!tab) return
  if (drag) cancel()
  drag = {
    source,
    tab,
    landing: { kind: 'none' },
    cursor: screen.getCursorScreenPoint(),
    hover: null,
    lastKey: null,
    ghost: createGhost(tab),
    timer: setInterval(tick, TICK_MS),
  }
  source.setTabDragging(true)
  source.ui.webContents.focus() // so Escape cancels
  tick()
}

function cleanUp() {
  const current = drag
  drag = null
  clearInterval(current.timer)
  if (current.ghost && !current.ghost.isDestroyed()) current.ghost.destroy()
  current.hover?.setDropHover(null)
  if (!current.source.closed) {
    current.source.setTabDragging(false)
    current.source.sendEvent('tab-drag-zone', { offer: false, zone: null })
  }
  return current
}

function cancel() {
  if (drag) cleanUp()
}

function end() {
  if (!drag) return
  tick()
  if (!drag) return // the tab or its window went away
  const { source, tab, landing, cursor } = cleanUp()
  if (landing.kind === 'merge') {
    landing.target.adoptTab(tab, landing.target.dropIndex)
    landing.target.focus()
  } else if (landing.kind === 'split') {
    source.splitWith(tab.id, landing.partnerId, landing.side)
  } else if (landing.kind === 'new-window') {
    source.moveToNewWindow(tab, cursor)
  }
}

module.exports = { start, end, cancel }
