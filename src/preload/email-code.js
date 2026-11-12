// Notices when a page is waiting for a code that was sent to your email, so the browser can offer to open your mail.
//
// The page's text is only read here, inside the page. The browser is told that there's a code to get, and nothing else:
// not the address on the page, and not what the page says. Most pages have no code field, so most pages never get as
// far as reading any text.
const { ipcRenderer } = require('electron')

const FIELD_TYPES = new Set(['text', 'tel', 'number', 'password', ''])
const SURELY_CODE = /\b(code|otp|otc|pin|passcode)\b|one ?time/
const MAYBE_CODE = /\btoken\b|verif/
// Other things that get called a code.
const OTHER_CODE = /promo|coupon|discount|gift|voucher|referr|invit|redeem|zip|postal|post ?code|area ?code|country|dial|phone|card|cvv|cvc|csc|captcha/
// "Verify your email" asks for your address again. "Email code" doesn't.
const SOMETHING_ELSE = /mail|user ?name|search|first ?name|last ?name|address|password/
const CODE = String.raw`\b(code|otp|passcode|pin)\b`
const MAILBOX = String.raw`(\be-?mail|\bmailbox\b|\binbox\b|@)`
const SAYS_EMAILED = [
  /\bcheck your (e-?mail|inbox|mail|mailbox)\b/, // check your email
  new RegExp(String.raw`\b(e-?mailed|mailed)\b.*${CODE}`), // we emailed you a code
  new RegExp(String.raw`${CODE}.*\b(e-?mailed|mailed)\b`), // the code we emailed you
  new RegExp(String.raw`\b(sent|delivered)\b.*${CODE}.*${MAILBOX}`), // we sent a code to your email
  new RegExp(String.raw`${CODE}.*\b(sent|delivered|received)\b.*${MAILBOX}`), // the code was sent to j***@example.com
  new RegExp(String.raw`${CODE}.*\b(from|in)\b.*\b(your|the|that)\b.*${MAILBOX}`), // the code from your email
  new RegExp(String.raw`\be-?mail (verification |security |confirmation |one.?time |login |sign.?in )?${CODE}`), // your email verification code
  /\b(sent|delivered)\b.*\b(to|at)\s+\S*@/, // we sent it to j***@example.com
  /\b(sent|delivered)\b.*(\be-?mail|\binbox\b)/, // we sent you an email with a code
  /\be-?mail\b.*\b(sent|on its way)\b/, // an email is on its way
  /^\s*\S+@\S+\s*$/, // an address on a line of its own, under "enter the code we sent to"
]
// Offers of another way, and lines about getting help, aren't saying that a code has been sent.
const ASIDE = /\b(instead|another way|different|try|resend|send again|send me|e-?mail me|contact|support|didn'?t|can'?t|no longer|subscribe|newsletter)\b/

/** A field's name for itself, as plain words: "verificationCode" and "verification-code" both come out the same. */
function fieldWords(field) {
  const labels = [...(field.labels ?? [])].map((label) => label.textContent)
  return [field.name, field.id, field.placeholder, field.getAttribute('aria-label'), field.autocomplete, field.getAttribute('data-testid'), ...labels]
    .filter(Boolean)
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase()
}

const isVisible = (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0
const usable = (field) => FIELD_TYPES.has(field.getAttribute('type')?.toLowerCase() ?? '') && !field.disabled && !field.readOnly

/** One box that wants a code. */
function looksLikeCodeField(field) {
  if (field.autocomplete === 'one-time-code') return true
  if (field.type === 'password') return false
  const words = fieldWords(field)
  if (OTHER_CODE.test(words)) return false
  if (SURELY_CODE.test(words)) return true
  if (SOMETHING_ELSE.test(words)) return false
  if (MAYBE_CODE.test(words)) return true
  // No useful name, but it's built for a short number.
  return field.inputMode === 'numeric' && field.maxLength >= 4 && field.maxLength <= 10
}

/** The empty field on this page that's waiting for a code, either one box or a row of boxes with one digit each. */
function waitingField() {
  const inputs = [...document.querySelectorAll('input')].filter(usable)
  const digits = inputs.filter((field) => field.maxLength === 1)
  const row = digits.find((field) => digits.filter((other) => other.parentElement === field.parentElement || other.parentElement?.parentElement === field.parentElement?.parentElement).length >= 4)
  if (row && digits.length <= 8 && digits.every((field) => !field.value && isVisible(field))) return row
  return inputs.find((field) => !field.value && looksLikeCodeField(field) && isVisible(field)) ?? null
}

/** Whether the words around a field say the code went to an email. Stops before it's reading the whole of a long page. */
function saysEmailed(field) {
  let node = field.parentElement
  for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
    const text = node.innerText ?? ''
    if (text.length > 4000) return false
    const sentences = text.toLowerCase().replace(/[’`]/g, "'").split(/[.!?\n]+/)
    if (sentences.some((line) => !ASIDE.test(line) && SAYS_EMAILED.some((pattern) => pattern.test(line)))) return true
  }
  return false
}

if (window === window.top && /^https?:$/.test(location.protocol)) {
  let told = '' // each page says so once, and sites that change pages by themselves are new pages
  let waiting = false

  const look = () => {
    waiting = false
    if (document.hidden || told === location.href) return
    const field = waitingField()
    if (!field || !saysEmailed(field)) return
    told = location.href
    ipcRenderer.send('email-code:seen')
  }
  const lookSoon = () => {
    if (waiting) return
    waiting = true
    setTimeout(look, 800)
  }

  window.addEventListener('DOMContentLoaded', () => {
    lookSoon()
    new MutationObserver(lookSoon).observe(document.documentElement, { childList: true, subtree: true })
    document.addEventListener('visibilitychange', lookSoon)
    document.addEventListener('focusin', lookSoon) // a field that was only hidden doesn't change the page's structure
  })
}
