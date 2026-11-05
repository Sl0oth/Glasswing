// Downloads go straight to the Downloads folder (like Safari) and show up in the toolbar.
const { app, shell: electronShell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const MAX_LISTED = 30
const downloads = [] // newest first
const items = new Map() // id → DownloadItem
let nextId = 1
let broadcastTimer = null

function uniquePath(dir, filename) {
  const safe = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'download'
  const { name, ext } = path.parse(safe)
  let candidate = path.join(dir, safe)
  for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${name} (${n})${ext}`)
  return candidate
}

/** Private and normal windows each list only their own downloads. */
function snapshot(isPrivate = false) {
  return downloads.filter((d) => d.private === isPrivate).map((d) => ({ ...d }))
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
  session.on('will-download', (_event, item) => {
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
    while (downloads.length > MAX_LISTED) items.delete(downloads.pop().id)

    item.on('updated', (_e, state) => {
      entry.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing'
      entry.received = item.getReceivedBytes()
      entry.total = item.getTotalBytes()
      broadcast()
    })
    item.once('done', (_e, state) => {
      entry.state = state // completed | cancelled | interrupted
      entry.received = item.getReceivedBytes()
      items.delete(entry.id)
      broadcast()
    })

    const { BrowserShell } = require('./shell')
    for (const shell of BrowserShell.all) {
      if (shell.private === isPrivate) shell.sendEvent('download-started', entry.filename)
    }
    broadcast()
  })
}

/** The last private window closed. The files stay where they were saved; only the list forgets them. */
function forgetPrivate() {
  for (let i = downloads.length - 1; i >= 0; i--) {
    if (downloads[i].private) downloads.splice(i, 1)
  }
  broadcast()
}

function find(id) {
  return downloads.find((d) => d.id === id)
}

const actions = {
  open: (id) => {
    const d = find(id)
    if (d?.state === 'completed') electronShell.openPath(d.path)
  },
  show: (id) => {
    const d = find(id)
    if (d) electronShell.showItemInFolder(d.path)
  },
  cancel: (id) => items.get(id)?.cancel(),
  clear: () => {
    for (let i = downloads.length - 1; i >= 0; i--) {
      if (downloads[i].state !== 'progressing' && downloads[i].state !== 'paused') downloads.splice(i, 1)
    }
    broadcast()
  },
}

module.exports = { setupDownloads, forgetPrivate, uniquePath, downloadAction: (action, id) => actions[action]?.(id), listDownloads: snapshot }
