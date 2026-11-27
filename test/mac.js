// The Mac-only parts: the encryption key kept by Apple's `security` tool, and updates that install themselves.
// Runs with plain Node (`node test/mac.js`). On a Mac it uses the real keychain and the real tools, so the build
// workflow runs it in a keychain made for the test, after building, with the .zip it's about to release.
// Anywhere else it checks only what doesn't need a Mac.
const assert = require('node:assert')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO = path.join(__dirname, '..')
const secrets = require(path.join(REPO, 'src/main/secrets.js'))
const macUpdate = require(path.join(REPO, 'src/main/mac-update.js'))
const isMac = process.platform === 'darwin'

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL ${name}\n       ${err.message}`)
  }
}
const until = async (fn, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return fn()
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'glasswing-test-'))

async function main() {
  console.log('Encryption')
  const key = crypto.randomBytes(32)
  await check('what it encrypts comes back', () => assert.equal(secrets.open(secrets.seal('hello ✓', key), key), 'hello ✓'))
  await check('and is marked as the new way', () => assert.ok(secrets.isOwn(secrets.seal('x', key))))
  await check('the old way is not', () => assert.ok(!secrets.isOwn(Buffer.from('v10' + 'x'.repeat(40)))))
  await check('a different key can’t read it', () => assert.throws(() => secrets.open(secrets.seal('x', key), crypto.randomBytes(32))))
  await check('nor can anyone change it unnoticed', () => {
    const data = secrets.seal('secret', key)
    data[data.length - 1] ^= 1
    assert.throws(() => secrets.open(data, key))
  })
  await check('the same text encrypts differently each time', () => assert.ok(!secrets.seal('x', key).equals(secrets.seal('x', key))))

  console.log('\nWhich update to fetch')
  const files = [
    { url: 'Glasswing-x64.zip', sha512: 'a' },
    { url: 'Glasswing-arm64.zip', sha512: 'b' },
    { url: 'Glasswing-arm64.dmg', sha512: 'c' },
  ]
  await check('the .zip for Apple chips', () => assert.equal(macUpdate.pickZip(files, 'arm64').url, 'Glasswing-arm64.zip'))
  await check('the .zip for Intel', () => assert.equal(macUpdate.pickZip(files, 'x64').url, 'Glasswing-x64.zip'))
  await check('nothing when there’s no .zip', () => assert.equal(macUpdate.pickZip([files[2]], 'arm64'), null))
  await check('the app it runs from', () => assert.equal(macUpdate.appBundle('/Applications/Glasswing.app/Contents/MacOS/Glasswing'), path.resolve('/Applications/Glasswing.app')))
  await check('none when running from source', () => assert.equal(macUpdate.appBundle('/usr/local/bin/electron'), null))
  await check('not from the disk image', () => assert.match(macUpdate.cannotInstall('/Volumes/Glasswing/Glasswing.app'), /disk image/))
  await check('not from a hidden copy macOS made', () => assert.match(macUpdate.cannotInstall('/private/var/folders/x/AppTranslocation/y/d/Glasswing.app'), /hidden copy/))

  if (!isMac) {
    console.log('\n(the rest needs a Mac)')
    return
  }

  console.log('\nThe key in the keychain')
  let first
  await check('one is made the first time', () => {
    first = secrets.keychainKey()
    assert.equal(first.length, 32)
  })
  await check('and the same one comes back after', () => assert.ok(secrets.keychainKey().equals(first)))
  await check('without asking anything: Apple’s tool reads it', () => {
    const out = require('node:child_process').execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Glasswing-Key', '-a', 'Glasswing', '-w'], { encoding: 'utf8' })
    assert.equal(Buffer.from(out.trim(), 'base64').length, 32)
  })
  await check('it encrypts and decrypts with it', () => assert.equal(secrets.decryptString(secrets.encryptString('saved')), 'saved'))

  console.log('\nSwapping the new version in')
  const swap = async (makeNew) => {
    const dir = tmp()
    const bundle = path.join(dir, 'Applications', 'Glasswing.app')
    fs.mkdirSync(bundle, { recursive: true })
    fs.writeFileSync(path.join(bundle, 'which'), 'old')
    const stage = path.join(dir, 'stage')
    const newApp = path.join(stage, 'Glasswing.app')
    if (makeNew) {
      fs.mkdirSync(newApp, { recursive: true })
      fs.writeFileSync(path.join(newApp, 'which'), 'new')
    }
    const running = spawn('/bin/sleep', ['1'])
    const script = macUpdate.swapAfterExit({ pid: running.pid, bundle, newApp, reopen: false })
    const code = await new Promise((resolve) => script.on('exit', resolve))
    return { dir, bundle, stage, code, which: fs.readFileSync(path.join(bundle, 'which'), 'utf8') }
  }
  {
    const { dir, which, stage, code } = await swap(true)
    await check('it waits for Glasswing to close, then the new one’s in its place', () => assert.equal(which, 'new'))
    await check('and the old one’s gone', () => assert.deepEqual(fs.readdirSync(path.join(dir, 'Applications')), ['Glasswing.app']))
    await check('and so is the download', () => assert.ok(!fs.existsSync(stage)))
    await check('and it says it worked', () => assert.equal(code, 0))
  }
  {
    const { dir, which, code } = await swap(false)
    await check('if the new one isn’t there, the old one stays', () => assert.equal(which, 'old'))
    await check('with nothing left over', () => assert.deepEqual(fs.readdirSync(path.join(dir, 'Applications')), ['Glasswing.app']))
    await check('and it says it didn’t work', () => assert.notEqual(code, 0))
  }
  await check('somewhere it can write, it can update itself', () => {
    const bundle = path.join(tmp(), 'Glasswing.app')
    fs.mkdirSync(bundle)
    assert.equal(macUpdate.cannotInstall(bundle), null)
  })

  const zip = path.join(REPO, 'dist', `Glasswing-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`)
  if (!fs.existsSync(zip)) {
    console.log('\n(no build in dist/, so not checking a real download)')
    return
  }
  console.log('\nA real update')
  const { version } = require(path.join(REPO, 'package.json'))
  const sha512 = await macUpdate.sha512Of(zip)
  const info = { version, files: [{ url: path.basename(zip), sha512 }] }
  let fetched = null
  const copy = (url, file) => {
    fetched = url
    fs.copyFileSync(zip, file)
  }
  let app
  await check('the release’s .zip is checked, unpacked and ready', async () => {
    app = await macUpdate.prepare(info, 'https://example.test/download/v1/', copy)
    assert.ok(fs.existsSync(path.join(app, 'Contents', 'MacOS', 'Glasswing')))
  })
  await check('from the release', () => assert.equal(fetched, `https://example.test/download/v1/${path.basename(zip)}`))
  await check('not marked as from the internet, so there’s nothing to approve', () => {
    const out = require('node:child_process').execFileSync('/usr/bin/xattr', ['-r', app], { encoding: 'utf8' })
    assert.ok(!out.includes('com.apple.quarantine'), out)
  })
  await check('a download that doesn’t match is refused', () =>
    assert.rejects(macUpdate.prepare({ version, files: [{ url: 'x-arm64.zip', sha512: 'wrong' }, { url: 'x-x64.zip', sha512: 'wrong' }] }, 'https://example.test', copy), /didn’t match/),
  )
  await check('so is the wrong version', () => assert.rejects(macUpdate.prepare({ ...info, version: '0.0.1' }, 'https://example.test', copy), /not 0\.0\.1/))
  if (app) fs.rmSync(path.dirname(app), { recursive: true, force: true })
}

main()
  .catch((err) => {
    failed++
    console.error(err)
  })
  .finally(() => {
    console.log(`\n${passed}/${passed + failed} checks passed`)
    process.exitCode = failed ? 1 : 0
  })
