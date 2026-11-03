// A small built-in password manager: offers to save on login, fills on the next visit.
// Passwords are encrypted with the OS keystore (DPAPI on Windows, Keychain on macOS).
const { ipcMain, safeStorage } = require('electron')
const crypto = require('node:crypto')
const prompts = require('./prompts')
const store = require('./store')

const recentPrompts = new Map() // de-dupe: several submit signals fire for one login

const entries = () => store.get('passwords') ?? []
const neverSave = () => store.get('passwordsNever') ?? []

function encrypt(text) {
  return safeStorage.encryptString(text).toString('base64')
}

function decrypt(data) {
  try {
    return safeStorage.decryptString(Buffer.from(data, 'base64'))
  } catch {
    return null
  }
}

function webOrigin(frame) {
  const origin = frame?.origin
  return typeof origin === 'string' && /^https?:\/\//.test(origin) ? origin : null
}

function credentialsFor(origin) {
  return entries()
    .filter((e) => e.origin === origin)
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .map((e) => ({ username: e.username, password: decrypt(e.password) }))
    .filter((e) => e.password != null)
}

async function offerToSave(event, origin, username, password) {
  const list = entries()
  const existing = list.find((e) => e.origin === origin && e.username === username)
  if (existing && decrypt(existing.password) === password) {
    existing.lastUsed = Date.now()
    store.set('passwords', list)
    return
  }

  const { BrowserShell } = require('./shell')
  const shell = BrowserShell.fromWebContents(event.sender)
  const host = new URL(origin).host
  const { button } = await prompts.ask(shell, {
    origin,
    title: existing ? 'Update password?' : 'Save password?',
    message: host,
    detail: username || 'No username detected',
    buttons: [
      { id: 'never', label: 'Never', style: 'secondary' },
      { id: 'later', label: 'Not Now', style: 'secondary' },
      { id: 'save', label: existing ? 'Update' : 'Save', style: 'primary' },
    ],
    cancelId: 'later',
  })

  if (button === 'never') {
    store.set('passwordsNever', [...new Set([...neverSave(), origin])])
  } else if (button === 'save') {
    const fresh = entries().filter((e) => !(e.origin === origin && e.username === username))
    fresh.push({ id: crypto.randomUUID(), origin, username, password: encrypt(password), lastUsed: Date.now() })
    store.set('passwords', fresh)
  }
}

function setupPasswords() {
  ipcMain.handle('autofill:get', (event) => {
    // The origin comes from the browser, not the page, so sites only ever get their own logins.
    const origin = webOrigin(event.senderFrame)
    if (!origin || !safeStorage.isEncryptionAvailable()) return []
    return credentialsFor(origin)
  })

  ipcMain.on('autofill:submitted', (event, data) => {
    const origin = webOrigin(event.senderFrame)
    const username = typeof data?.username === 'string' ? data.username.slice(0, 256) : ''
    const password = typeof data?.password === 'string' ? data.password.slice(0, 1024) : ''
    if (!origin || !password || !safeStorage.isEncryptionAvailable()) return
    if (neverSave().includes(origin)) return

    const key = `${origin}\n${username}\n${password}`
    const now = Date.now()
    if (now - (recentPrompts.get(key) ?? 0) < 10_000) return
    recentPrompts.set(key, now)
    offerToSave(event, origin, username, password).catch((err) => console.error('Password save failed:', err))
  })
}

/** Summaries for the glasswing://passwords page (never includes the passwords themselves). */
function listForPage() {
  return {
    saved: entries()
      .map(({ id, origin, username, lastUsed }) => ({ id, origin, username, lastUsed }))
      .sort((a, b) => a.origin.localeCompare(b.origin)),
    never: neverSave(),
  }
}

function remove(id) {
  store.set('passwords', entries().filter((e) => e.id !== id))
}

function removeNever(origin) {
  store.set('passwordsNever', neverSave().filter((o) => o !== origin))
}

module.exports = { setupPasswords, listForPage, remove, removeNever }
