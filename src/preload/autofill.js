// Runs in every web page's isolated world: fills saved logins and notices new ones.
const { ipcRenderer } = require('electron')

if (location.protocol === 'https:' || location.protocol === 'http:') {
  const USER_FIELDS =
    'input[autocomplete~="username"], input[type="email"], input[type="text"], input[type="tel"], input:not([type])'
  const filled = new WeakSet()
  let credentials = null
  let lastSent = ''

  const getCredentials = () => (credentials ??= ipcRenderer.invoke('autofill:get').catch(() => []))

  const isVisible = (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0

  /** The username field that belongs with a password field: the last text-ish input before it. */
  function usernameFieldFor(password) {
    const scope = password.form ?? password.closest('form') ?? document
    const explicit = scope.querySelector('input[autocomplete~="username"]')
    if (explicit) return explicit
    let match = null
    for (const el of scope.querySelectorAll(USER_FIELDS)) {
      if (el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING && isVisible(el)) match = el
    }
    return match
  }

  // Assigning from the isolated world + firing input/change keeps React/Vue/etc. in sync.
  function setValue(el, value) {
    el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  async function fill() {
    const fields = [...document.querySelectorAll('input[type="password"]')].filter(
      (f) => !filled.has(f) && !f.value && f.autocomplete !== 'new-password' && isVisible(f),
    )
    if (!fields.length) return
    const [best] = await getCredentials()
    if (!best) return
    for (const password of fields) {
      filled.add(password)
      const user = usernameFieldFor(password)
      if (user && !user.value && best.username) setValue(user, best.username)
      setValue(password, best.password)
    }
  }

  function capture(password) {
    if (!password?.value || password.autocomplete === 'one-time-code') return
    // New-password forms with a confirmation field: one entry is enough.
    const username = usernameFieldFor(password)?.value ?? ''
    const key = `${username}\n${password.value}`
    if (key === lastSent) return
    lastSent = key
    ipcRenderer.send('autofill:submitted', { username, password: password.value })
  }

  const filledPasswordIn = (scope) =>
    [...(scope ?? document).querySelectorAll('input[type="password"]')].find((p) => p.value)

  // Classic form submits.
  document.addEventListener('submit', (e) => capture(filledPasswordIn(e.target)), true)
  // Script-driven logins: Enter in a password field, or clicking a button next to one.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'password') capture(e.target)
    },
    true,
  )
  document.addEventListener(
    'click',
    (e) => {
      const button = e.target instanceof Element ? e.target.closest('button, input[type="submit"], [role="button"]') : null
      if (!button) return
      capture(filledPasswordIn(button.form ?? button.closest('form')))
    },
    true,
  )

  // Fill now, and again when single-page apps render their login forms later.
  let timer = null
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(fill, 250)
  }
  window.addEventListener('DOMContentLoaded', () => {
    fill()
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
  })
}
