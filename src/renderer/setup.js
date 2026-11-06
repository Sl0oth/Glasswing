'use strict'

const $ = (selector) => document.querySelector(selector)
const api = window.setup
const steps = [...document.querySelectorAll('section')]
const NEXT_LABELS = { welcome: 'Get Started', updates: 'Start Browsing' }

let state = null
let index = 0
let importDone = false

const stepName = () => steps[index].dataset.step
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

// ── Moving between steps ─────────────────────────────────────────────────

const dots = $('#dots')
steps.forEach(() => dots.append(document.createElement('i')))

function selectedBrowser() {
  const picked = document.querySelector('input[name="browser"]:checked')
  if (!picked) return null
  const select = picked.closest('.option').querySelector('select')
  return { id: picked.value, profile: select ? select.value : picked.dataset.profile }
}

function wantedParts() {
  return { bookmarks: $('#part-bookmarks').checked, history: $('#part-history').checked, settings: $('#part-settings').checked }
}

function willImport() {
  return stepName() === 'import' && !importDone && Boolean(selectedBrowser()) && Object.values(wantedParts()).some(Boolean)
}

function refreshButtons() {
  const name = stepName()
  $('#back').hidden = index === 0
  $('#skip').hidden = !willImport()
  $('#next').textContent = willImport() ? 'Import' : NEXT_LABELS[name] ?? 'Continue'
  $('#next').disabled = false
}

function show(next) {
  index = Math.max(0, Math.min(steps.length - 1, next))
  steps.forEach((section, i) => section.classList.toggle('current', i === index))
  ;[...dots.children].forEach((dot, i) => dot.classList.toggle('on', i <= index))
  refreshButtons()
}

$('#back').addEventListener('click', () => show(index - 1))
$('#skip').addEventListener('click', () => show(index + 1))
$('#close').addEventListener('click', () => api.finish())
$('#next').addEventListener('click', async () => {
  if (willImport()) return runImport()
  if (stepName() === 'updates') return api.finish()
  show(index + 1)
})

// ── Import ───────────────────────────────────────────────────────────────

function describeProfile(profile) {
  const parts = []
  if (profile.bookmarks) parts.push(plural(profile.bookmarks, 'bookmark'))
  if (profile.history) parts.push(plural(profile.history, 'history item'))
  return parts.join(' · ') || 'Nothing to bring over yet'
}

function renderBrowsers() {
  const list = $('#browser-list')
  list.replaceChildren()
  const has = state.browsers.length > 0
  $('#import-parts').hidden = !has
  $('#import-note').hidden = !has
  if (!has) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'Chrome, Brave and Edge weren’t found on this computer, so there’s nothing to bring over.'
    list.append(empty)
    return
  }
  // Start on the profile that's actually in use, in the browser used most recently. Failing that,
  // whichever has the most in it.
  const amount = (profile) => profile.bookmarks + profile.history
  const usual = (browser) =>
    browser.profiles.find((p) => p.lastUsed && amount(p) > 0) ?? browser.profiles.reduce((a, b) => (amount(b) > amount(a) ? b : a))
  const recency = (browser) => Math.max(...browser.profiles.filter((p) => amount(p) > 0).map((p) => p.activeTime), 0)
  const rank = (browser) => [recency(browser), amount(usual(browser))]
  const first = state.browsers.reduce((best, b) => {
    const [time, size] = rank(b)
    const [bestTime, bestSize] = rank(best)
    return time > bestTime || (time === bestTime && size > bestSize) ? b : best
  })

  for (const browser of state.browsers) {
    const row = document.createElement('label')
    row.className = 'option'
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'browser'
    radio.value = browser.id
    radio.dataset.profile = browser.profiles[0].dir
    radio.checked = browser === first && amount(usual(browser)) > 0
    const text = document.createElement('span')
    const name = document.createElement('b')
    name.textContent = browser.name
    const detail = document.createElement('small')
    const best = usual(browser)
    radio.dataset.profile = best.dir
    detail.textContent = describeProfile(best)
    text.append(name, detail)
    row.append(radio, text)
    if (browser.profiles.length > 1) {
      const select = document.createElement('select')
      select.setAttribute('aria-label', `${browser.name} profile`)
      for (const profile of browser.profiles) select.add(new Option(profile.name, profile.dir, false, profile === best))
      select.addEventListener('change', () => {
        detail.textContent = describeProfile(browser.profiles.find((p) => p.dir === select.value))
        radio.checked = true
        refreshButtons()
      })
      row.append(select)
    }
    list.append(row)
  }
  list.addEventListener('change', refreshButtons)
}

for (const id of ['#part-bookmarks', '#part-history', '#part-settings']) $(id).addEventListener('change', refreshButtons)

function importSummary(result) {
  const parts = []
  if (result.favorites) parts.push(`${plural(result.favorites, 'favorite')} added`)
  if (result.moreBookmarks) parts.push(`${plural(result.moreBookmarks, 'more bookmark')} that’ll come up as you type in the address bar`)
  if (result.history) parts.push(plural(result.history, 'history item'))
  if (result.settings.length) parts.push(result.settings.join(', '))
  let text = parts.length ? `Done: ${parts.join('; ')}.` : 'There was nothing new to bring over.'
  if (result.failed.length) text += ` Couldn’t read: ${result.failed.join(', ')}.`
  return text
}

async function runImport() {
  const browser = selectedBrowser()
  const next = $('#next')
  const out = $('#import-result')
  next.disabled = true
  next.textContent = 'Importing…'
  out.hidden = true
  let result
  try {
    result = await api.import(browser.id, browser.profile, wantedParts())
  } catch {
    result = { ok: false, error: 'Something went wrong.' }
  }
  out.hidden = false
  out.classList.toggle('bad', !result.ok || result.failed.length > 0)
  if (result.ok) {
    importDone = true
    out.textContent = importSummary(result)
    // An import can change the search engine and the favorites bar shown on the next step.
    const fresh = await api.state()
    state.engine = fresh.engine
    state.appearance = fresh.appearance
    renderChoices()
  } else {
    out.textContent = result.error
  }
  refreshButtons()
}

// ── Look ─────────────────────────────────────────────────────────────────

function paint() {
  const a = state.appearance
  const root = document.documentElement.style
  root.setProperty('--c1', a.colors[0])
  root.setProperty('--c2', a.colors[1])
  root.setProperty('--angle', `${a.angle}deg`)
  root.setProperty('--tint', String(a.tint))
  root.setProperty('--grain', String(a.grain))
  root.setProperty('--accent', a.accent)
}

async function change(partial) {
  Object.assign(state.appearance, partial)
  paint()
  renderChoices()
  state.appearance = await api.appearance(partial)
}

function renderLookOptions() {
  const presets = $('#presets')
  for (const preset of state.presets) {
    const button = document.createElement('button')
    button.className = 'preset'
    button.title = preset.name
    button.setAttribute('aria-label', preset.name)
    button.dataset.id = preset.id
    button.style.background = `linear-gradient(135deg, ${preset.colors[0]}, ${preset.colors[1]})`
    button.addEventListener('click', () => change({ theme: preset.id, colors: preset.colors }))
    presets.append(button)
  }
  const accents = $('#accents')
  for (const color of state.accents) {
    const button = document.createElement('button')
    button.className = 'accent'
    button.dataset.color = color
    button.setAttribute('aria-label', `Accent ${color}`)
    button.style.background = color
    button.addEventListener('click', () => change({ accent: color }))
    accents.append(button)
  }
  for (const button of document.querySelectorAll('#material button')) {
    button.addEventListener('click', () => change({ material: button.dataset.value }))
  }
  $('#tint-range').addEventListener('input', (e) => change({ tint: Number(e.target.value) }))
}

// ── Browsing and updates ─────────────────────────────────────────────────

function renderEngines() {
  const box = $('#engines')
  for (const engine of state.engines) {
    const button = document.createElement('button')
    button.textContent = engine.name
    button.dataset.id = engine.id
    button.addEventListener('click', async () => {
      state.engine = await api.search(engine.id)
      renderChoices()
    })
    box.append(button)
  }
}

function bindSwitch(selector, partial) {
  $(selector).addEventListener('change', (e) => change(partial(e.target.checked)))
}

function bindProtection(selector, key) {
  $(selector).addEventListener('change', async (e) => {
    const next = await api.protection({ [key]: e.target.checked })
    state.protection = { ads: next.ads, trackers: next.trackers }
  })
}

/** Shows the current value of everything, without rebuilding anything. */
function renderChoices() {
  const a = state.appearance
  for (const el of document.querySelectorAll('.preset')) el.classList.toggle('on', el.dataset.id === a.theme)
  for (const el of document.querySelectorAll('.accent')) el.classList.toggle('on', el.dataset.color === a.accent)
  for (const el of document.querySelectorAll('#material button')) el.classList.toggle('on', el.dataset.value === a.material)
  for (const el of document.querySelectorAll('#engines button')) el.classList.toggle('on', el.dataset.id === state.engine)
  $('#tint-range').value = a.tint
  $('#auto-hide').checked = a.autoHide
  $('#favorites-bar').checked = a.favoritesBar
  $('#fullscreen').checked = a.fullscreen
  $('#ads').checked = state.protection.ads
  $('#trackers').checked = state.protection.trackers
  const mode = document.querySelector(`input[name="updates"][value="${state.updates}"]`)
  if (mode) mode.checked = true
}

// ── Start ────────────────────────────────────────────────────────────────

async function init() {
  state = await api.state()
  $('#logo').src = state.icon
  paint()
  renderBrowsers()
  renderLookOptions()
  renderEngines()
  renderChoices()
  bindSwitch('#auto-hide', (on) => ({ autoHide: on }))
  bindSwitch('#favorites-bar', (on) => ({ favoritesBar: on }))
  bindSwitch('#fullscreen', (on) => ({ fullscreen: on }))
  bindProtection('#ads', 'ads')
  bindProtection('#trackers', 'trackers')
  for (const radio of document.querySelectorAll('input[name="updates"]')) {
    radio.addEventListener('change', async () => {
      state.updates = await api.updates(radio.value)
    })
  }
  show(state.firstRun ? 0 : 1) // coming back from the menu is about importing, not being welcomed
}

init()
