// Installs updates on a Mac without the .dmg. macOS's own updater (Squirrel) only installs apps signed with a paid
// Apple certificate, so Glasswing does it itself:
//
//   1. It downloads the new version's .zip and checks it against the sha512 in the release's latest-mac.yml.
//   2. It unpacks it, and checks that the new app's signature holds and that it's the version it should be.
//   3. When you quit, or click Restart, a small script waits for Glasswing to close, swaps the new app in where the
//      old one was and, for Restart, opens it.
//
// A file macOS sees a browser download gets marked as from the internet, and opening one of those is what needs
// Privacy & Security's "Open Anyway". Glasswing downloads these itself, so they're never marked: you only approve
// Glasswing the first time you install it.
//
// It can only replace itself where it's allowed to write. When it can't (still on the disk image, say), or when a
// swap didn't happen, it offers the .dmg the way it used to.
const { execFile, spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pipeline } = require('node:stream/promises')
const { Readable, Transform } = require('node:stream')

const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { encoding: 'utf8' }, (err, stdout, stderr) => (err ? reject(new Error(`${path.basename(cmd)}: ${stderr.trim() || err.message}`)) : resolve(stdout.trim()))),
  )

// $1 Glasswing's process, $2 the app to replace, $3 the new app, $4 1 to open it afterwards.
const SWAP_SCRIPT = `
pid="$1"; app="$2"; new="$3"; reopen="$4"
tries=0
while kill -0 "$pid" 2>/dev/null; do
  sleep 0.2
  tries=$((tries + 1))
  [ "$tries" -gt 300 ] && exit 1
done
old="$app.old-$$"
mv "$app" "$old" || exit 1
if mv "$new" "$app"; then rm -rf "$old"; else mv "$old" "$app"; exit 1; fi
xattr -dr com.apple.quarantine "$app" 2>/dev/null
touch "$app"
rm -rf "$(dirname "$new")"
[ "$reopen" = 1 ] && open "$app"
exit 0
`

/** The Glasswing.app this is running from, or null when running from source. */
function appBundle(execPath = process.execPath) {
  const bundle = path.resolve(execPath, '..', '..', '..')
  return bundle.endsWith('.app') ? bundle : null
}

/** Why it can't replace the app at `bundle`, or null if it can. */
function cannotInstall(bundle = appBundle()) {
  if (!bundle) return 'not running from an app'
  if (bundle.includes('/AppTranslocation/')) return 'macOS is running it from a hidden copy' // opened before it was moved
  if (bundle.startsWith('/Volumes/')) return 'running from the disk image'
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK)
    fs.accessSync(bundle, fs.constants.W_OK)
  } catch {
    return 'not allowed to write there'
  }
  return null
}

/** The .zip for this kind of Mac, from the files latest-mac.yml lists. */
function pickZip(files, arch = process.arch) {
  const want = `-${arch === 'arm64' ? 'arm64' : 'x64'}.zip`
  return (files ?? []).find((f) => typeof f?.url === 'string' && f.url.endsWith(want) && f.sha512) ?? null
}

async function downloadWithElectron(url, file) {
  const { net } = require('electron')
  const res = await net.fetch(url)
  if (!res.ok) throw new Error(`the download failed (${res.status})`)
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file))
}

async function sha512Of(file) {
  const hash = crypto.createHash('sha512')
  await pipeline(fs.createReadStream(file), new Transform({ transform: (chunk, _enc, done) => (hash.update(chunk), done()) }))
  return hash.digest('base64')
}

/**
 * Downloads and checks `version`. Returns the path of the new Glasswing.app, ready to swap in.
 * `base` is where the release's files are; `download` is for testing.
 */
async function prepare({ version, files }, base, download = downloadWithElectron) {
  const zip = pickZip(files)
  if (!zip) throw new Error('the release has no .zip for this Mac')
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'glasswing-update-'))
  try {
    const file = path.join(dir, 'update.zip')
    await download(/^https?:\/\//.test(zip.url) ? zip.url : `${base.replace(/\/$/, '')}/${zip.url}`, file)
    if ((await sha512Of(file)) !== zip.sha512) throw new Error('the download didn’t match the release')
    await run('/usr/bin/ditto', ['-x', '-k', file, dir])
    await fs.promises.rm(file)
    const app = path.join(dir, 'Glasswing.app')
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]).catch(() => {})
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
    const got = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(app, 'Contents', 'Info.plist')])
    if (got !== version) throw new Error(`the download is version ${got}, not ${version}`)
    return app
  } catch (err) {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/** Starts the script that swaps `newApp` in once process `pid` has gone. It carries on after Glasswing quits. */
function swapAfterExit({ pid = process.pid, bundle = appBundle(), newApp, reopen }) {
  const child = spawn('/bin/sh', ['-c', SWAP_SCRIPT, 'glasswing-update', String(pid), bundle, newApp, reopen ? '1' : '0'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  return child
}

let ready = null // { version, app }
let reopen = false
let hooked = false

/** Swaps the update in when Glasswing quits, whatever makes it quit. */
function installOnQuit(version, newApp) {
  ready = { version, app: newApp }
  if (hooked) return
  hooked = true
  const { app } = require('electron')
  app.on('will-quit', () => {
    if (!ready) return
    require('./store').set('macUpdateInstalling', ready.version)
    require('./store').flush()
    swapAfterExit({ newApp: ready.app, reopen })
    ready = null
  })
}

function restartToInstall() {
  reopen = true
  require('electron').app.quit()
}

/**
 * Whether this copy can update itself. False when it can't write where it is, or when a swap from this version
 * didn't happen (it was still this version after one), so the .dmg is offered instead.
 */
function canSelfUpdate() {
  const store = require('./store')
  const { app } = require('electron')
  const tried = store.get('macUpdateInstalling')
  if (tried) {
    store.set('macUpdateInstalling', null)
    if (tried !== app.getVersion()) {
      console.error(`Installing ${tried} didn’t work; offering the .dmg instead`)
      store.set('macSelfUpdateFailed', app.getVersion()) // until this copy's replaced some other way
    }
  }
  if (store.get('macSelfUpdateFailed') === app.getVersion()) return false
  const why = cannotInstall()
  if (why) console.warn(`Can’t update in place: ${why}`)
  return !why
}

module.exports = { SWAP_SCRIPT, appBundle, cannotInstall, pickZip, sha512Of, prepare, swapAfterExit, installOnQuit, restartToInstall, canSelfUpdate }
