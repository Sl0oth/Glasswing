// Downloads go straight to the Downloads folder (like Safari) and show up in the toolbar.
const { app, shell: electronShell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const MAX_LISTED = 30
const downloads = [] // newest first
const items = new Map() // id → DownloadItem, while it's still going
const sessions = new Map() // id → the session it came from, to download it again
let nextId = 1
let broadcastTimer = null

function uniquePath(dir, filename) {
  const safe = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'download'
  const { name, ext } = path.parse(safe)
  let candidate = path.join(dir, safe)
  for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${name} (${n})${ext}`)
  return candidate
}

/** Private and normal windows each list only their own downloads. A finished file you've since moved or deleted says so. */
function snapshot(isPrivate = false) {
  return downloads
    .filter((d) => d.private === isPrivate)
    .map((d) => ({ ...d, missing: d.state === 'completed' && !fs.existsSync(d.path), canResume: Boolean(items.get(d.id)?.canResume()) }))
}

function broadcast() {
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    const { BrowserShell } = require('./shell')
    for (const shell of BrowserShell.all) shell.sendEvent('downloads', snapshot(shell.private))
  }, 150)
}

function setupDownloads(session, { isPrivate = false } = {}) {
  session.on('will-download', (_event, item, webContents) => {
    const savePath = uniquePath(app.getPath('downloads'), item.getFilename())
    item.setSavePath(savePath)

    const entry = {
      id: nextId++,
      private: isPrivate,
      filename: path.basename(savePath),
      path: savePath,
      url: item.getURL(),
      state: 'progressing',
      received: 0,
      total: item.getTotalBytes(),
      startedAt: Date.now(),
    }
    downloads.unshift(entry)
    items.set(entry.id, item)
    sessions.set(entry.id, session)
    while (downloads.length > MAX_LISTED) forget(downloads.pop().id)

    item.on('updated', (_e, state) => {
      entry.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing'
      entry.received = item.getReceivedBytes()
      entry.total = item.getTotalBytes()
      broadcast()
    })
    item.on('done', (_e, state) => { // can come twice: an interrupted download you resume finishes again
      entry.state = state // completed | cancelled | interrupted
      entry.received = item.getReceivedBytes()
      // An interrupted download can sometimes pick up where it stopped, so keep hold of it.
      if (state !== 'interrupted') items.delete(entry.id)
      broadcast()
    })

    const { BrowserShell } = require('./shell')
    // The file flies across the window it came from. Other windows just show that it arrived.
    const origin = BrowserShell.fromWebContents(webContents)
    for (const shell of BrowserShell.all) {
      if (shell.private !== isPrivate) continue
      shell.sendEvent('download-started')
      if (shell !== origin) shell.sendEvent('download-landed')
    }
    if (origin?.private === isPrivate) {
      require('./animations').flyDownload(origin, entry.filename, () => {
        if (!origin.closed) origin.sendEvent('download-landed')
      })
    }
    broadcast()
  })
}

/** The last private window closed. The files stay where they were saved; only the list forgets them. */
function forgetPrivate() {
  for (let i = downloads.length - 1; i >= 0; i--) {
    if (downloads[i].private) forget(downloads.splice(i, 1)[0].id)
  }
  broadcast()
}

function find(id) {
  return downloads.find((d) => d.id === id)
}

function forget(id) {
  items.delete(id)
  sessions.delete(id)
}

function remove(id) {
  const index = downloads.findIndex((d) => d.id === id)
  if (index === -1) return
  const [d] = downloads.splice(index, 1)
  if (d.state === 'progressing' || d.state === 'paused') items.get(id)?.cancel()
  forget(id)
  broadcast()
}

const running = (d) => d?.state === 'progressing' || d?.state === 'paused'

const actions = {
  open: (id) => {
    const d = find(id)
    if (d?.state === 'completed' && fs.existsSync(d.path)) electronShell.openPath(d.path)
  },
  show: (id) => {
    const d = find(id)
    if (!d) return
    // If the file's gone, open the folder it was in.
    if (fs.existsSync(d.path)) electronShell.showItemInFolder(d.path)
    else electronShell.openPath(path.dirname(d.path))
  },
  pause: (id) => items.get(id)?.pause(),
  resume: (id) => {
    const item = items.get(id)
    if (item?.canResume()) item.resume()
  },
  cancel: (id) => items.get(id)?.cancel(),
  /** Picks up an interrupted download where it stopped if it can, or starts it again as a new one. */
  retry: (id) => {
    const d = find(id)
    if (!d || running(d)) return
    const item = items.get(id)
    if (d.state === 'interrupted' && item?.canResume()) return item.resume()
    const session = sessions.get(id)
    if (!session) return
    remove(id)
    session.downloadURL(d.url)
  },
  'copy-link': (id) => {
    const d = find(id)
    if (d?.url) require('electron').clipboard.writeText(d.url)
  },
  /** Moves the file to the Recycle Bin, so it can still be brought back, and takes it off the list. */
  delete: async (id) => {
    const d = find(id)
    if (!d || running(d)) return
    if (fs.existsSync(d.path)) {
      try {
        await electronShell.trashItem(d.path)
      } catch (err) {
        console.error('Could not delete download:', err)
        return
      }
    }
    remove(id)
  },
  remove: (id) => {
    if (!running(find(id))) remove(id)
  },
  refresh: () => broadcast(),
  clear: () => {
    for (let i = downloads.length - 1; i >= 0; i--) {
      if (!running(downloads[i])) forget(downloads.splice(i, 1)[0].id)
    }
    broadcast()
  },
}

/** The ⋯ menu for one download, with what fits its state. */
function downloadMenu(shell, id, x, y) {
  const d = find(id)
  if (!d || d.private !== shell.private) return
  const missing = d.state === 'completed' && !fs.existsSync(d.path)
  const item = items.get(id)
  const run = (action) => () => actions[action](id)
  const template = running(d)
    ? [
        d.state === 'paused'
          ? { label: 'Resume', enabled: Boolean(item?.canResume()), click: run('resume') }
          : { label: 'Pause', click: run('pause') },
        { label: 'Cancel', click: run('cancel') },
        { type: 'separator' },
        { label: 'Copy Download Link', click: run('copy-link') },
      ]
    : d.state === 'completed' && !missing
      ? [
          { label: 'Open', click: run('open') },
          { label: 'Show in Folder', click: run('show') },
          { type: 'separator' },
          { label: 'Copy Download Link', click: run('copy-link') },
          { label: 'Download Again', click: run('retry') },
          { type: 'separator' },
          { label: 'Delete File', click: run('delete') },
          { label: 'Remove from List', click: run('remove') },
        ]
      : [
          { label: d.state === 'interrupted' && item?.canResume() ? 'Resume' : missing ? 'Download Again' : 'Retry', click: run('retry') },
          { label: 'Show Folder', click: run('show') },
          { type: 'separator' },
          { label: 'Copy Download Link', click: run('copy-link') },
          { label: 'Remove from List', click: run('remove') },
        ]
  require('./menus').showMenu(shell, template, { x, y, keepDownloads: true })
}

module.exports = {
  setupDownloads,
  forgetPrivate,
  uniquePath,
  downloadMenu,
  downloadAction: (action, id) => (Object.hasOwn(actions, action) ? actions[action](id) : undefined),
  listDownloads: snapshot,
}
