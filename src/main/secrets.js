// Encrypts saved passwords and sign-ins. Works like Electron's safeStorage, which is what Windows and Linux use.
//
// A Mac is different. There safeStorage keeps its key in the keychain, and macOS only lets the app that made a
// keychain item read it without asking. Without a paid Apple certificate every version of Glasswing counts as a new
// app, so you'd type your password after every update, and at every start until you chose "Always Allow".
//
// So on a Mac the key is kept in your keychain by Apple's own `security` tool, and read back through it. The tool is
// always the same app, so it's never asked about. The key is still in the keychain, locked when you're logged out,
// and not in Glasswing's folder, but other programs running as you could read it the same way.
//
// What the old way encrypted is still read once, with the old key, and saved again the new way (see `migrate`).
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')

const MAGIC = Buffer.from('gw1:')
const SERVICE = 'Glasswing-Key'
const ACCOUNT = 'Glasswing'
const SECURITY = '/usr/bin/security'
const usesOwnKey = process.platform === 'darwin'

let key // undefined: not looked for yet; null: couldn't get one

const safeStorage = () => require('electron').safeStorage

/** Gets the key from the keychain, making one the first time. `run` is for testing. */
function keychainKey(run = execFileSync) {
  try {
    const found = run(SECURITY, ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const bytes = Buffer.from(found.trim(), 'base64')
    if (bytes.length === 32) return bytes
  } catch {} // not made yet
  const made = crypto.randomBytes(32)
  // Through `security -i` so the key goes in on stdin, not in a command line other programs can see.
  run(SECURITY, ['-i'], { input: `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${made.toString('base64')}\n`, stdio: ['pipe', 'ignore', 'ignore'] })
  const check = run(SECURITY, ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  if (check.trim() !== made.toString('base64')) throw new Error('the keychain didn’t keep the key')
  return made
}

function ownKey() {
  if (key === undefined) {
    try {
      key = keychainKey()
    } catch (err) {
      console.error('Could not get the encryption key from the keychain:', err.message)
      key = null
    }
  }
  return key
}

function isEncryptionAvailable() {
  return usesOwnKey ? ownKey() != null : safeStorage().isEncryptionAvailable()
}

function seal(text, k) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv)
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()])
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
}

function open(data, k) {
  const iv = data.subarray(MAGIC.length, MAGIC.length + 12)
  const tag = data.subarray(MAGIC.length + 12, MAGIC.length + 28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data.subarray(MAGIC.length + 28)), decipher.final()]).toString('utf8')
}

const isOwn = (data) => data.length > MAGIC.length + 28 && data.subarray(0, MAGIC.length).equals(MAGIC)

/** Returns a Buffer, like safeStorage. */
function encryptString(text) {
  if (!usesOwnKey) return safeStorage().encryptString(text)
  const k = ownKey()
  if (!k) throw new Error('Encryption is not available')
  return seal(text, k)
}

/** Throws if it can't, like safeStorage. Something saved the old way is read with the old key: macOS asks that once. */
function decryptString(data) {
  if (usesOwnKey && isOwn(data)) {
    const k = ownKey()
    if (!k) throw new Error('Encryption is not available')
    return open(data, k)
  }
  return safeStorage().decryptString(data)
}

/** True for what's saved the old way, so it can be saved again the new way. Always false off a Mac. */
const needsMigrating = (data) => usesOwnKey && !isOwn(data)

module.exports = { isEncryptionAvailable, encryptString, decryptString, needsMigrating, keychainKey, seal, open, isOwn }
