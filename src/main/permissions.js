// Electron grants every permission by default. A real browser asks first.
const { SCHEME } = require('./constants')
const prompts = require('./prompts')
const store = require('./store')

const ALWAYS_ALLOW = new Set([
  'fullscreen',
  'pointerLock',
  'keyboardLock',
  'clipboard-sanitized-write',
  'mediaKeySystem',
  'speaker-selection',
])

const LABELS = {
  media: 'your camera or microphone',
  geolocation: 'your location',
  notifications: 'show notifications',
  midi: 'your MIDI devices',
  midiSysex: 'your MIDI devices',
  'clipboard-read': 'read your clipboard',
  'display-capture': 'share your screen',
  'idle-detection': 'know when you’re idle',
  'window-management': 'manage windows on your displays',
  'storage-access': 'use cookies and site data',
  'top-level-storage-access': 'use cookies and site data',
  openExternal: 'open an external application',
  fileSystem: 'access files on your device',
}

const pending = new Map()

function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function isTrusted(origin) {
  return !origin || origin.startsWith('chrome-extension://') || origin.startsWith(`${SCHEME}://`) || origin === 'devtools://devtools'
}

function describe(permission, details) {
  if (permission === 'media') {
    const types = details.mediaTypes ?? []
    if (types.includes('video') && types.includes('audio')) return 'use your camera and microphone'
    if (types.includes('video')) return 'use your camera'
    if (types.includes('audio')) return 'use your microphone'
  }
  const label = LABELS[permission] ?? `use “${permission}”`
  return /^(show|read|share|know|manage|use|open|access)/.test(label) ? label : `use ${label}`
}

function decisionKey(origin, permission) {
  return `${origin} ${permission}`
}

async function ask(webContents, permission, origin, details, remember) {
  const { BrowserShell } = require('./shell')
  const shell = BrowserShell.fromWebContents(webContents) ?? BrowserShell.lastFocused()
  let host = origin
  try {
    host = new URL(origin).host || origin
  } catch {}

  const { button, checked } = await prompts.ask(shell, {
    origin,
    title: host,
    message: `wants to ${describe(permission, details)}`,
    buttons: [
      { id: 'block', label: 'Block', style: 'secondary' },
      { id: 'allow', label: 'Allow', style: 'primary' },
    ],
    cancelId: 'dismiss',
    ...(remember && { checkbox: { label: 'Remember for this site', checked: true } }),
  })
  if (button === 'dismiss') return false // closed without answering: don't remember
  const allowed = button === 'allow'
  if (remember && checked) {
    store.set('permissions', { ...store.get('permissions'), [decisionKey(origin, permission)]: allowed })
  }
  return allowed
}

/** `remember: false` is for private windows: nothing saved is used, and nothing is saved. */
function setupPermissions(session, { remember = true } = {}) {
  const savedDecision = (key) => (remember ? store.get('permissions')[key] : undefined)

  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const decide = (allowed) => {
      // Every use of the camera or mic comes through here, from any frame, so the tab's icons can't be dodged.
      if (allowed && permission === 'media') {
        const { BrowserShell } = require('./shell')
        BrowserShell.fromWebContents(webContents)?.tabs.get(webContents.id)?.captureAllowed(details.mediaTypes, details.isMainFrame)
      }
      callback(allowed)
    }

    const origin = originOf(details.requestingUrl)
    if (ALWAYS_ALLOW.has(permission) || isTrusted(origin)) return decide(true)

    const saved = savedDecision(decisionKey(origin, permission))
    if (typeof saved === 'boolean') return decide(saved)

    // Coalesce duplicate prompts (pages often request the same thing several times).
    const key = `${webContents.id} ${decisionKey(origin, permission)}`
    if (!pending.has(key)) {
      pending.set(key, ask(webContents, permission, origin, details, remember).finally(() => pending.delete(key)))
    }
    pending.get(key).then(decide, () => decide(false))
  })

  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    const origin = originOf(requestingOrigin) ?? requestingOrigin
    if (ALWAYS_ALLOW.has(permission) || isTrusted(origin)) return true
    const saved = savedDecision(decisionKey(origin, permission))
    if (typeof saved === 'boolean') return saved
    // Unknown: report "not granted" for sensitive capabilities, allow the harmless rest.
    return !(permission in LABELS)
  })
}

module.exports = { setupPermissions }
