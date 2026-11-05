// In-browser prompt cards (save password, permissions, add extension, ...) drawn by the toolbar UI
// in Glasswing's own style instead of native OS dialogs.
let nextId = 1
const pending = new Map() // id → { shell, resolve, cancelId }

/**
 * Shows a prompt card in `shell` and resolves with `{ button, checked, values }`.
 * `buttons`: [{ id, label, style: 'primary' | 'secondary' | 'danger' }]. Clicking outside the card
 * or pressing Escape answers with `cancelId`.
 * `fields`: optional text inputs, [{ id, label, value, type }]. Their text comes back in `values`.
 * `tag`: a name for the card, so closeTagged can take it away if it stops being needed.
 */
function ask(shell, { title, message, detail, icon, origin, buttons, cancelId, checkbox, fields, tag }) {
  if (!shell || shell.closed) return Promise.resolve({ button: cancelId, checked: false, values: {} })
  const id = nextId++
  const iconUrl = icon && typeof icon.toDataURL === 'function' && !icon.isEmpty() ? icon.toDataURL() : typeof icon === 'string' ? icon : null
  return new Promise((resolve) => {
    pending.set(id, { shell, resolve, cancelId, tag })
    if (fields) shell.ui.webContents.focus()
    shell.sendEvent('prompt', { id, title, message, detail, icon: iconUrl, origin, buttons, cancelId, checkbox, fields })
  })
}

function respond(shell, id, button, checked, values) {
  const entry = pending.get(id)
  if (!entry || entry.shell !== shell) return
  pending.delete(id)
  const valid = typeof button === 'string' ? button : entry.cancelId
  entry.resolve({ button: valid, checked: Boolean(checked), values: values ?? {} })
}

/** Cancels everything still open in a window that's closing. */
function cancelAll(shell) {
  for (const [id, entry] of pending) {
    if (entry.shell !== shell) continue
    pending.delete(id)
    entry.resolve({ button: entry.cancelId, checked: false, values: {} })
  }
}

/** Takes away a card that no longer applies, answering it with its `cancelId`. */
function closeTagged(tag) {
  for (const [id, entry] of pending) {
    if (entry.tag === tag) entry.shell.sendEvent('prompt-close', id)
  }
}

module.exports = { ask, respond, cancelAll, closeTagged }
