// Private windows share a session that exists only in memory. It gets the same protections as normal
// browsing, but no password filling and no extensions. Closing the last private window ends it, and
// the next private window starts with a new one, so nothing carries over from one to the next.
const { session } = require('electron')
const path = require('node:path')

let current = null
let opened = 0

function configure(ses) {
  require('./protocol').registerInternalProtocol(ses, { isPrivate: true })
  require('./permissions').setupPermissions(ses, { remember: false })
  require('./downloads').setupDownloads(ses, { isPrivate: true })
  require('./google-signin').setupGoogleSignIn(ses)
  require('./blocker').protect(ses)
  ses.registerPreloadScript({
    id: 'glasswing-capture',
    type: 'frame',
    filePath: path.join(__dirname, '..', 'preload', 'capture.js'),
  })
  ses.registerPreloadScript({
    id: 'glasswing-split-links',
    type: 'frame',
    filePath: path.join(__dirname, '..', 'preload', 'split-links.js'),
  })
  ses.registerPreloadScript({
    id: 'glasswing-youtube-recovery',
    type: 'frame',
    filePath: path.join(__dirname, '..', 'preload', 'youtube-recovery.js'),
  })
}

function acquire() {
  if (current) return current
  opened += 1
  current = session.fromPartition(`glasswing-private-${opened}`) // no "persist:", so never on disk
  configure(current)
  return current
}

function end() {
  const ended = current
  current = null
  require('./downloads').forgetPrivate()
  ended?.clearData().catch((err) => console.error('Could not clear a private session:', err))
}

module.exports = { acquire, end }
