// In-browser prompt cards (save password, permissions, add extension, ...) drawn by the toolbar UI
// in Glasswing's own style instead of native OS dialogs.
let nextId = 1
const pending = new Map() // id → { shell, resolve, cancelId }

/**
 * Shows a prompt card in `shell` and resolves with `{ button, checked }`.
 * `buttons`: [{ id, label, style: 'primary' | 'secondary' | 'danger' }]. Clicking outside the card
 * or pressing Escape answers with `cancelId`.
 */
function ask(shell, { title, message, detail, icon, origin, buttons, cancelId, checkbox }) {
  if (!shell || shell.closed) return Promise.resolve({ button: cancelId, checked: false })
  const id = nextId++
  const iconUrl = icon && typeof icon.toDataURL === 'function' && !icon.isEmpty() ? icon.toDataURL() : typeof icon === 'string' ? icon : null
  return new Promise((resolve) => {
    pending.set(id, { shell, resolve, cancelId })
    shell.sendEvent('prompt', { id, title, message, detail, icon: iconUrl, origin, buttons, cancelId, checkbox })
  })
}

function respond(shell, id, button, checked) {
  const entry = pending.get(id)
  if (!entry || entry.shell !== shell) return
  pending.delete(id)
  const valid = typeof button === 'string' ? button : entry.cancelId
  entry.resolve({ button: valid, checked: Boolean(checked) })
}

/** Cancels everything still open in a window that's closing. */
function cancelAll(shell) {
  for (const [id, entry] of pending) {
    if (entry.shell !== shell) continue
    pending.delete(id)
    entry.resolve({ button: entry.cancelId, checked: false })
  }
}

module.exports = { ask, respond, cancelAll }
