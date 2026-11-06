// Short movements that make the browser feel alive. Nothing waits for them, and they never get in the way
// of input: pages keep working while they slide, and a flying download is in a window clicks pass through.
//
// Pages slide at their full size. Changing a page's size every frame would make it lay itself out again every frame.
// Windows' "Animation effects" setting turns all of this off.
const { BrowserWindow, screen, systemPreferences } = require('electron')

const FRAME_MS = 16
const SLIDE_MS = 170
const FLIGHT_TIMEOUT_MS = 2500

const enabled = () => !systemPreferences.getAnimationSettings().prefersReducedMotion
const easeOut = (t) => 1 - (1 - t) ** 3
const easeIn = (t) => t ** 3

/** Calls `onFrame` with progress from 0 to 1. Returns a function that stops it, without calling `onDone`. */
function tween(ms, ease, onFrame, onDone) {
  const start = Date.now()
  const timer = setInterval(() => {
    const t = Math.min(1, (Date.now() - start) / ms)
    onFrame(ease(t))
    if (t < 1) return
    clearInterval(timer)
    onDone?.()
  }, FRAME_MS)
  return () => clearInterval(timer)
}

/** Where the file starts: under the pointer if it's over the window, or else the middle of the window. */
function startPoint(bounds) {
  const cursor = screen.getCursorScreenPoint()
  const x = cursor.x - bounds.x
  const y = cursor.y - bounds.y
  if (x >= 0 && y >= 0 && x < bounds.width && y < bounds.height) return { x, y }
  return { x: bounds.width / 2, y: bounds.height / 2 }
}

const DOWNLOADS_BUTTON_X = `(() => {
  const r = document.getElementById('downloads-btn').getBoundingClientRect()
  return r.left + r.width / 2
})()`

/** Flies a file across the window to the downloads button. `landed` is called when it arrives, or if it can't fly. */
async function flyDownload(shell, filename, landed) {
  const { win } = shell
  let overlay = null
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    clearTimeout(timeout)
    if (overlay && !overlay.isDestroyed()) overlay.destroy()
    landed()
  }
  const timeout = setTimeout(finish, FLIGHT_TIMEOUT_MS)
  try {
    if (!enabled() || win.isDestroyed() || win.isMinimized() || !win.isVisible() || shell.htmlFullscreen) return finish()
    shell.peek()
    const endX = await shell.ui.webContents.executeJavaScript(DOWNLOADS_BUTTON_X)
    if (finished || win.isDestroyed()) return finish()

    const bounds = win.getContentBounds()
    overlay = new BrowserWindow({
      ...bounds,
      parent: win, // stays over its own window, and goes away if that does
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: { session: shell.session, sandbox: true, contextIsolation: true },
    })
    overlay.setIgnoreMouseEvents(true)
    await overlay.webContents.loadURL('glasswing://ui/flight.html')
    if (finished || overlay.isDestroyed() || win.isDestroyed()) return finish()
    overlay.showInactive()
    const route = { filename, from: startPoint(bounds), to: { x: endX, y: 24 } }
    await overlay.webContents.executeJavaScript(`window.fly(${JSON.stringify(route)})`)
  } catch (err) {
    if (!finished) console.error('Could not animate a download:', err) // once finished, its window is gone on purpose
  }
  finish()
}

module.exports = { SLIDE_MS, enabled, easeIn, easeOut, tween, flyDownload }
