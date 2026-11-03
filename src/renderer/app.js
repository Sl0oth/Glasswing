'use strict'

const api = window.glasswing
const $ = (selector, root = document) => root.querySelector(selector)

const ICONS = {
  globe: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14M8 2C6.2 3.7 5.4 5.7 5.4 8s.8 4.3 2.6 6"/></svg>',
  lock: '<svg viewBox="0 0 16 16"><rect x="3.5" y="7" width="9" height="6.5" rx="1.6"/><path d="M5.5 7V5.3a2.5 2.5 0 0 1 5 0V7"/></svg>',
  warn: '<svg viewBox="0 0 16 16"><path d="M8 2.6l5.8 10.4H2.2z"/><path d="M8 6.8v2.6M8 11.2v.01"/></svg>',
  search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2L13.5 13.5"/></svg>',
  clock: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.75"/><path d="M8 5v3.2l2 1.3"/></svg>',
  tab: '<svg viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="9" rx="2"/><path d="M2.5 6.5h11"/></svg>',
  puzzle: '<svg viewBox="0 0 16 16"><path d="M3 6h2.2a1.3 1.3 0 1 1 2.6 0H10v2.2a1.3 1.3 0 1 1 0 2.6V13H3z"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  speaker: '<svg viewBox="0 0 16 16"><path d="M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5z"/><path d="M10.6 5.9a3 3 0 0 1 0 4.2M12.5 4.1a5.6 5.6 0 0 1 0 7.8"/></svg>',
  muted: '<svg viewBox="0 0 16 16"><path d="M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5z"/><path d="M10.8 6.4l3 3M13.8 6.4l-3 3"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h3.8l1.5 1.5h5.7v6.5h-11z"/></svg>',
  check: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  key: '<svg viewBox="0 0 16 16"><circle cx="5.5" cy="10.5" r="2.75"/><path d="M7.5 8.5L13 3M11 5l1.5 1.5M9.5 6.5L11 8"/></svg>',
  crashed: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.75"/><path d="M6 6.2v.01M10 6.2v.01M5.6 11c1.4-1.3 3.4-1.3 4.8 0"/></svg>',
}

const FAVICON_SERVICE = (host) => `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`
const PLACEHOLDER = 'Search DuckDuckGo or enter website name'

document.body.classList.add(`platform-${api.platform}`)

// ── State ────────────────────────────────────────────────────────────────

let state = { tabs: [], activeId: null }
const tabEls = new Map()
const loadingBefore = new Map()
let editing = false
let flashText = null
let dragState = null
let menuOpen = false
const prompts = new Map() // id → { data, el }

const strip = $('#tabstrip')
const address = $('#address-template').content.firstElementChild.cloneNode(true)
const addressInput = $('#address-input', address)
const addressText = $('#address-text', address)
const addressIcon = $('#address-icon', address)
const zoomPill = $('#zoom-pill', address)
const reloadBtn = $('#reload', address)
const suggestionsEl = $('#suggestions')
const downloadsPanel = $('#downloads-panel')
const customizePanel = $('#customize-panel')
const mainPanel = $('#main-panel')
const downloadsBtn = $('#downloads-btn')
const findInput = $('#find-input')
const findCount = $('#find-count')

const activeTab = () => state.tabs.find((t) => t.id === state.activeId) ?? null
const activeEl = () => tabEls.get(state.activeId) ?? null

// ── URL helpers ──────────────────────────────────────────────────────────

function isNewTabUrl(url) {
  return !url || url.startsWith('glasswing://newtab')
}

function parse(url) {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function searchQueryOf(url) {
  const u = parse(url)
  if (u && /(^|\.)duckduckgo\.com$/.test(u.hostname) && u.pathname === '/' && u.searchParams.get('q')) {
    return u.searchParams.get('q')
  }
  return null
}

function displayInfo(tab) {
  const url = tab?.url ?? ''
  if (isNewTabUrl(url)) return { text: '', kind: 'empty' }
  const query = searchQueryOf(url)
  if (query) return { text: query, kind: 'search' }
  const u = parse(url)
  if (!u) return { text: url, kind: 'other' }
  if (u.protocol === 'https:') return { text: u.hostname.replace(/^www\./, ''), kind: 'secure' }
  if (u.protocol === 'http:') return { text: u.hostname.replace(/^www\./, ''), kind: 'insecure' }
  if (u.protocol === 'glasswing:') return { text: u.hostname.charAt(0).toUpperCase() + u.hostname.slice(1), kind: 'internal' }
  if (u.protocol === 'chrome-extension:') return { text: tab.title || 'Extension', kind: 'extension' }
  return { text: url, kind: 'other' }
}

function editValue(tab) {
  const url = tab?.url ?? ''
  if (isNewTabUrl(url)) return ''
  return searchQueryOf(url) ?? url
}

function looksLikeUrl(text) {
  const t = text.trim()
  if (!t || /\s/.test(t)) return false
  return /^[a-z][a-z0-9+.-]*:/i.test(t) || /^localhost(:\d+)?(\/|$)/i.test(t) || /^[^\s/?#:]+\.[a-z][a-z0-9-]{1,62}(:\d+)?([/?#].*)?$/i.test(t)
}

function hostOf(url) {
  return parse(url)?.hostname.replace(/^www\./, '') ?? url
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function setIcon(container, { favicon, fallback = ICONS.globe }) {
  if (favicon) {
    let img = container.querySelector('img')
    if (!img || img.dataset.src !== favicon) {
      img = document.createElement('img')
      img.dataset.src = favicon
      img.src = favicon
      img.onerror = () => (container.innerHTML = fallback)
      container.replaceChildren(img)
    }
  } else if (container.dataset.fallback !== fallback || container.querySelector('img')) {
    container.innerHTML = fallback
  }
  container.dataset.fallback = favicon ? '' : fallback
}

// ── Tabs ─────────────────────────────────────────────────────────────────

function createTabEl(id) {
  const el = document.createElement('div')
  el.className = 'tab'
  el.dataset.id = id
  el.innerHTML = `
    <button class="tab-close" title="Close Tab" tabindex="-1">${ICONS.close}</button>
    <span class="tab-icon"></span>
    <span class="tab-title"></span>
    <button class="tab-audio" tabindex="-1" hidden></button>`

  const closeBtn = $('.tab-close', el)
  closeBtn.addEventListener('mousedown', (e) => e.stopPropagation())
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    api.send('close-tab', id)
  })

  const audioBtn = $('.tab-audio', el)
  audioBtn.addEventListener('mousedown', (e) => e.stopPropagation())
  audioBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    api.send('toggle-mute', id)
  })

  el.addEventListener('mousedown', (e) => onTabMouseDown(e, id, el))
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) api.send('close-tab', id)
  })
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    api.send('tab-menu', id, e.clientX, e.clientY)
  })
  tabEls.set(id, el)
  return el
}

function updateTabEl(el, tab) {
  const isActive = tab.id === state.activeId
  el.classList.toggle('active', isActive)
  el.classList.toggle('loading', tab.loading)
  el.title = isActive ? '' : tab.title

  const title = $('.tab-title', el)
  const text = isNewTabUrl(tab.url) && !tab.loading ? 'New Tab' : tab.title
  if (title.textContent !== text) title.textContent = text

  const icon = $('.tab-icon', el)
  if (tab.crashed) setIcon(icon, { fallback: ICONS.crashed })
  else setIcon(icon, { favicon: tab.favicon })

  const audio = $('.tab-audio', el)
  const showAudio = tab.audible || tab.muted
  audio.hidden = !showAudio
  if (showAudio) {
    const markup = tab.muted ? ICONS.muted : ICONS.speaker
    if (audio.dataset.state !== String(tab.muted)) {
      audio.innerHTML = markup
      audio.dataset.state = String(tab.muted)
    }
    audio.title = tab.muted ? 'Unmute Tab' : 'Mute Tab'
  }

  // Progress bar completion flourish.
  const wasLoading = loadingBefore.get(tab.id)
  if (wasLoading && !tab.loading) {
    el.classList.add('load-done')
    setTimeout(() => el.classList.remove('load-done'), 650)
  } else if (tab.loading) {
    el.classList.remove('load-done')
  }
  loadingBefore.set(tab.id, tab.loading)
}

function onTabMouseDown(e, id, el) {
  if (e.button === 1) {
    e.preventDefault() // no autoscroll
    return
  }
  if (e.button !== 0) return

  const wasActive = id === state.activeId
  if (wasActive && editing) return // let the input handle caret/selection
  e.preventDefault()
  if (!wasActive) api.send('select-tab', id)

  const startX = e.clientX
  dragState = { id, el, moved: false }

  const others = () => [...strip.children].filter((c) => c !== el)
  const targetIndex = (x) => {
    const list = others()
    const i = list.findIndex((c) => {
      const r = c.getBoundingClientRect()
      return x < r.left + r.width / 2
    })
    return i === -1 ? list.length : i
  }

  const onMove = (ev) => {
    const dx = ev.clientX - startX
    if (!dragState.moved && Math.abs(dx) < 6) return
    if (state.tabs.length < 2) return
    dragState.moved = true
    el.classList.add('dragging')
    el.style.transform = `translateX(${dx}px)`
  }

  const onUp = (ev) => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    const moved = dragState?.moved
    dragState = null
    el.classList.remove('dragging')
    el.style.transform = ''
    if (moved) {
      const index = targetIndex(ev.clientX)
      strip.insertBefore(el, others()[index] ?? null)
      api.send('move-tab', id, index)
    } else if (wasActive) {
      beginEdit()
    }
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// ── Rendering ────────────────────────────────────────────────────────────

function render() {
  const body = document.body.classList
  body.toggle('single-tab', state.tabs.length <= 1)
  body.toggle('chrome-hidden', Boolean(state.chromeHidden))
  body.toggle('revealed', Boolean(state.revealed))
  body.toggle('find-open', Boolean(state.findOpen))
  body.toggle('fullscreen', Boolean(state.fullscreen))
  body.toggle('blurred', state.focused === false)

  const tab = activeTab()
  $('#back').disabled = !tab?.canGoBack
  $('#forward').disabled = !tab?.canGoForward

  // Reconcile tab elements by id.
  const ids = new Set(state.tabs.map((t) => t.id))
  for (const [id, el] of tabEls) {
    if (!ids.has(id)) {
      el.remove()
      tabEls.delete(id)
      loadingBefore.delete(id)
    }
  }
  state.tabs.forEach((t, i) => {
    const el = tabEls.get(t.id) ?? createTabEl(t.id)
    updateTabEl(el, t)
    if (!dragState && strip.children[i] !== el) strip.insertBefore(el, strip.children[i] ?? null)
  })
  if (!mainPanel.hidden) syncMainPanel()

  const el = activeEl()
  if (el && address.parentElement !== el) {
    if (editing) endEdit()
    el.appendChild(address)
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  updateAddress()
}

function updateAddress() {
  const tab = activeTab()
  if (!tab) return
  const info = displayInfo(tab)

  address.classList.toggle('placeholder', !info.text && !flashText)
  address.classList.toggle('flash', Boolean(flashText))
  addressText.textContent = flashText ?? (info.text || PLACEHOLDER)
  addressInput.placeholder = PLACEHOLDER

  addressIcon.className = 'address-icon'
  if (flashText) {
    addressIcon.innerHTML = ''
  } else if (tab.crashed) {
    addressIcon.innerHTML = ICONS.crashed
  } else if (info.kind === 'empty' || info.kind === 'search') {
    addressIcon.innerHTML = ICONS.search
  } else if (info.kind === 'insecure') {
    addressIcon.classList.add('insecure')
    addressIcon.innerHTML = ICONS.warn
    addressIcon.title = 'Not secure'
  } else if (info.kind === 'extension' || info.kind === 'internal') {
    const host = parse(tab.url)?.hostname
    const fallback = host === 'history' ? ICONS.clock : host === 'passwords' ? ICONS.key : ICONS.puzzle
    setIcon(addressIcon, { favicon: tab.favicon, fallback })
  } else {
    setIcon(addressIcon, { favicon: tab.favicon, fallback: info.kind === 'secure' ? ICONS.lock : ICONS.globe })
  }
  if (info.kind !== 'insecure') addressIcon.title = ''

  zoomPill.hidden = !tab.zoom || tab.zoom === 100
  zoomPill.textContent = `${tab.zoom}%`
  reloadBtn.title = tab.loading ? 'Stop' : 'Reload'
  reloadBtn.hidden = info.kind === 'empty'
}

// ── Address editing & suggestions ────────────────────────────────────────

let typed = ''
let originalValue = ''
let items = []
let selected = 0
let local = { tabs: [], history: [], completion: null }
let remote = []
let suggestSeq = 0
let remoteTimer = null

function beginEdit() {
  const tab = activeTab()
  if (!tab) return
  if (!editing) {
    editing = true
    address.classList.add('editing')
    activeEl()?.classList.add('editing')
    originalValue = editValue(tab)
    addressInput.value = originalValue
    typed = originalValue
  }
  addressInput.focus()
  addressInput.select()
}

function endEdit() {
  if (!editing) return
  editing = false
  address.classList.remove('editing')
  for (const el of tabEls.values()) el.classList.remove('editing')
  hideSuggestions()
  updateAddress()
  if (state.chromeHidden) scheduleConceal()
}

function navigate(text, newTab = false) {
  if (!text.trim()) return
  api.send('navigate', text, { newTab })
  addressInput.blur()
}

function requestSuggestions(query, allowCompletion) {
  const seq = ++suggestSeq
  clearTimeout(remoteTimer)
  if (!query.trim()) {
    local = { tabs: [], history: [], completion: null }
    remote = []
    hideSuggestions()
    return
  }

  api.invoke('suggest-local', query).then((result) => {
    if (seq !== suggestSeq || !editing) return
    local = result
    if (allowCompletion && result.completion && addressInput.value === query) {
      const completion = result.completion.replace(/\/$/, '')
      if (completion.toLowerCase().startsWith(query.toLowerCase()) && completion.length > query.length) {
        addressInput.value = query + completion.slice(query.length)
        addressInput.setSelectionRange(query.length, addressInput.value.length)
      }
    }
    renderSuggestions()
  })

  remoteTimer = setTimeout(() => {
    api.invoke('suggest-search', query).then((list) => {
      if (seq !== suggestSeq || !editing) return
      remote = list
      renderSuggestions()
    })
  }, 110)
}

function buildItems() {
  const value = addressInput.value.trim()
  const query = typed.trim()
  const list = []
  const isUrl = looksLikeUrl(value)
  list.push({
    kind: 'default',
    value,
    icon: isUrl ? ICONS.globe : ICONS.search,
    title: value,
    sub: isUrl ? 'Go to site' : 'DuckDuckGo Search',
  })

  if (local.tabs.length) {
    list.push({ section: 'Switch to Tab' })
    for (const t of local.tabs) {
      list.push({ kind: 'tab', id: t.id, icon: ICONS.tab, title: t.title, sub: hostOf(t.url), badge: 'Switch to Tab' })
    }
  }

  if (local.history.length) {
    list.push({ section: 'History' })
    for (const h of local.history) {
      list.push({ kind: 'url', value: h.url, favicon: FAVICON_SERVICE(hostOf(h.url)), icon: ICONS.clock, title: h.title || hostOf(h.url), sub: h.url.replace(/^https?:\/\/(www\.)?/, '') })
    }
  }

  const phrases = remote.filter((p) => p.toLowerCase() !== query.toLowerCase()).slice(0, 6)
  if (phrases.length) {
    list.push({ section: 'DuckDuckGo Suggestions' })
    for (const p of phrases) list.push({ kind: 'search', value: p, icon: ICONS.search, title: p })
  }
  return list
}

function renderSuggestions() {
  if (!editing || !typed.trim()) return hideSuggestions()
  items = buildItems()
  if (!items[selected] || items[selected].section) selected = 0

  suggestionsEl.innerHTML = items
    .map((item, i) => {
      if (item.section) return `<div class="section-label">${escapeHtml(item.section)}</div>`
      const icon = item.favicon ? `<img src="${escapeHtml(item.favicon)}" data-fallback="1">` : item.icon
      return `<div class="row${i === selected ? ' selected' : ''}" data-index="${i}">
        <span class="row-icon">${icon}</span>
        <span class="row-title">${escapeHtml(item.title)}</span>
        ${item.sub ? `<span class="row-sub">— ${escapeHtml(item.sub)}</span>` : ''}
        ${item.badge ? `<span class="row-badge">${escapeHtml(item.badge)}</span>` : ''}
      </div>`
    })
    .join('')
  for (const img of suggestionsEl.querySelectorAll('img[data-fallback]')) {
    img.onerror = () => (img.parentElement.innerHTML = ICONS.globe)
  }
  showSuggestions()
}

function showSuggestions() {
  const el = activeEl()
  if (!el) return
  const r = el.getBoundingClientRect()
  const width = Math.min(Math.max(r.width, 560), window.innerWidth - 16)
  const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8))
  suggestionsEl.style.left = `${left}px`
  suggestionsEl.style.top = `${r.bottom + 8}px`
  suggestionsEl.style.width = `${width}px`
  suggestionsEl.hidden = false
  syncExpanded()
}

function hideSuggestions() {
  if (suggestionsEl.hidden) return
  suggestionsEl.hidden = true
  suggestionsEl.innerHTML = ''
  items = []
  selected = 0
  syncExpanded()
}

function moveSelection(delta) {
  if (!items.length) return
  let i = selected
  do {
    i = (i + delta + items.length) % items.length
  } while (items[i].section)
  selected = i
  const item = items[i]
  addressInput.value = item.kind === 'default' ? typed : item.kind === 'tab' ? item.title : item.value
  for (const row of suggestionsEl.querySelectorAll('.row')) {
    row.classList.toggle('selected', Number(row.dataset.index) === selected)
  }
}

function activate(item, newTab = false) {
  if (!item || item.kind === 'default') return navigate(addressInput.value, newTab)
  if (item.kind === 'tab') {
    api.invoke('switch-to-tab', item.id)
    addressInput.blur()
    return
  }
  navigate(item.value, newTab)
}

addressInput.addEventListener('input', (e) => {
  typed = addressInput.value
  selected = 0
  const atEnd = addressInput.selectionEnd === addressInput.value.length
  requestSuggestions(typed, e.inputType === 'insertText' && atEnd)
})

addressInput.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      moveSelection(1)
      break
    case 'ArrowUp':
      e.preventDefault()
      moveSelection(-1)
      break
    case 'Enter':
      e.preventDefault()
      activate(items[selected], e.altKey)
      break
    case 'Escape':
      e.preventDefault()
      if (!suggestionsEl.hidden || addressInput.value !== originalValue) {
        hideSuggestions()
        addressInput.value = originalValue
        typed = originalValue
        addressInput.select()
      } else {
        addressInput.blur()
        api.send('focus-page')
      }
      break
  }
})

addressInput.addEventListener('blur', endEdit)

suggestionsEl.addEventListener('mousedown', (e) => e.preventDefault()) // keep input focus
suggestionsEl.addEventListener('click', (e) => {
  const row = e.target.closest('.row')
  if (row) activate(items[Number(row.dataset.index)], e.ctrlKey || e.metaKey)
})

reloadBtn.addEventListener('mousedown', (e) => e.stopPropagation())
reloadBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  api.send(activeTab()?.loading ? 'stop' : 'reload')
})

zoomPill.addEventListener('mousedown', (e) => e.stopPropagation())
zoomPill.addEventListener('click', (e) => {
  e.stopPropagation()
  api.send('zoom-reset')
})

function flash(message) {
  flashText = message
  updateAddress()
  setTimeout(() => {
    flashText = null
    updateAddress()
  }, 1600)
}

// ── Expanded overlay (dropdowns need the UI view to cover the page) ──────

let expanded = false

function syncExpanded() {
  const want =
    !suggestionsEl.hidden ||
    !downloadsPanel.hidden ||
    !customizePanel.hidden ||
    !mainPanel.hidden ||
    menuOpen ||
    prompts.size > 0
  if (want === expanded) return
  expanded = want
  document.body.classList.toggle('expanded', want)
  api.send('expand', want)
  if (!want && state.chromeHidden) scheduleConceal()
}

$('#scrim').addEventListener('mousedown', (e) => {
  e.preventDefault()
  downloadsPanel.hidden = true
  customizePanel.hidden = true
  mainPanel.hidden = true
  closeMenus()
  dismissAllPrompts()
  if (editing) {
    addressInput.blur()
    api.send('focus-page')
  }
  hideSuggestions()
  syncExpanded()
})

// ── Toolbar buttons ──────────────────────────────────────────────────────

$('#back').addEventListener('click', () => api.send('back'))
$('#forward').addEventListener('click', () => api.send('forward'))
$('#new-tab').addEventListener('click', () => api.send('new-tab'))
$('#new-tab').addEventListener('contextmenu', (e) => {
  e.preventDefault()
  const r = e.currentTarget.getBoundingClientRect()
  api.send('new-tab-menu', Math.max(8, r.right - 300), r.bottom + 6)
})
$('#menu-btn').addEventListener('click', () => toggleMainPanel())
for (const btn of document.querySelectorAll('.wc')) {
  btn.addEventListener('click', () => api.send('window', btn.dataset.action))
}

// ── Focus mode / full screen: reveal on hover ────────────────────────────

let concealTimer = null

$('#reveal-strip').addEventListener('mouseenter', () => {
  if (state.chromeHidden && !state.revealed) api.send('reveal', true)
})

document.documentElement.addEventListener('mouseenter', () => clearTimeout(concealTimer))
document.documentElement.addEventListener('mouseleave', scheduleConceal)

function scheduleConceal() {
  clearTimeout(concealTimer)
  concealTimer = setTimeout(() => {
    if (!state.chromeHidden || !state.revealed) return
    if (editing || expanded || document.activeElement === findInput) return
    if (document.documentElement.matches(':hover')) return
    document.body.classList.remove('revealed')
    setTimeout(() => api.send('reveal', false), 180)
  }, 450)
}

// ── Find in page ─────────────────────────────────────────────────────────

findInput.addEventListener('input', () => {
  api.send('find', findInput.value, { newSession: true, forward: true })
})

findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    api.send('find', findInput.value, { newSession: false, forward: !e.shiftKey })
  } else if (e.key === 'Escape') {
    e.preventDefault()
    api.send('find-close')
  }
})

$('#find-prev').addEventListener('click', () => api.send('find', findInput.value, { newSession: false, forward: false }))
$('#find-next').addEventListener('click', () => api.send('find', findInput.value, { newSession: false, forward: true }))
$('#find-done').addEventListener('click', () => api.send('find-close'))
findInput.addEventListener('blur', () => state.chromeHidden && scheduleConceal())

function showFound({ active, matches }) {
  if (!findInput.value) {
    findCount.textContent = ''
    findCount.classList.remove('none')
    return
  }
  findCount.textContent = matches ? `${active} of ${matches}` : 'Not found'
  findCount.classList.toggle('none', !matches)
}

// ── Downloads ────────────────────────────────────────────────────────────

let downloads = []

function formatBytes(n) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${units[i]}`
}

function renderDownloads() {
  downloadsBtn.hidden = downloads.length === 0
  const running = downloads.filter((d) => d.state === 'progressing' || d.state === 'paused')
  downloadsBtn.classList.toggle('active', running.length > 0)
  const total = running.reduce((s, d) => s + (d.total || 0), 0)
  const received = running.reduce((s, d) => s + (d.received || 0), 0)
  const fraction = total ? received / total : 0.1
  downloadsBtn.style.setProperty('--dl-offset', String(62.83 * (1 - fraction)))

  const list = $('#downloads-list')
  if (!downloads.length) {
    list.innerHTML = '<div class="dl-empty">No downloads</div>'
    return
  }
  list.innerHTML = downloads
    .map((d) => {
      const ext = (d.filename.match(/\.([a-z0-9]{1,4})$/i)?.[1] ?? '').slice(0, 4)
      const inProgress = d.state === 'progressing' || d.state === 'paused'
      const meta = inProgress
        ? `${formatBytes(d.received)}${d.total ? ` of ${formatBytes(d.total)}` : ''}`
        : d.state === 'completed'
          ? formatBytes(d.received)
          : d.state === 'cancelled'
            ? 'Cancelled'
            : 'Failed'
      const pct = d.total ? Math.round((d.received / d.total) * 100) : 0
      return `<div class="dl-item" data-id="${d.id}" data-state="${d.state}">
        <div class="dl-file-icon">${escapeHtml(ext) || ICONS.folder}</div>
        <div style="min-width:0">
          <div class="dl-name">${escapeHtml(d.filename)}</div>
          <div class="dl-meta">${meta}</div>
          ${inProgress ? `<div class="dl-bar"><div style="width:${pct}%"></div></div>` : ''}
        </div>
        ${inProgress
          ? `<button class="icon-btn small" data-action="cancel" title="Cancel">${ICONS.close}</button>`
          : `<button class="icon-btn small" data-action="show" title="Show in folder">${ICONS.folder}</button>`}
      </div>`
    })
    .join('')
}

function positionDownloads() {
  const r = downloadsBtn.getBoundingClientRect()
  downloadsPanel.style.top = `${r.bottom + 8}px`
  downloadsPanel.style.left = `${Math.max(8, Math.min(r.right - 340, window.innerWidth - 348))}px`
}

function toggleDownloads(force) {
  const open = force ?? downloadsPanel.hidden
  if (open) {
    customizePanel.hidden = true
    mainPanel.hidden = true
    if (downloadsBtn.hidden) downloadsBtn.hidden = false
    renderDownloads()
    positionDownloads()
  }
  downloadsPanel.hidden = !open
  syncExpanded()
}

downloadsBtn.addEventListener('click', () => toggleDownloads())
$('#downloads-clear').addEventListener('click', () => api.send('download', 'clear'))
$('#downloads-list').addEventListener('click', (e) => {
  const item = e.target.closest('.dl-item')
  if (!item) return
  const id = Number(item.dataset.id)
  const action = e.target.closest('button')?.dataset.action
  if (action) api.send('download', action, id)
  else if (item.dataset.state === 'completed') api.send('download', 'open', id)
})

// ── Appearance ───────────────────────────────────────────────────────────

let look = null
let pendingLook = null

const SLIDERS = {
  angle: (v) => `${v}°`,
  tint: (v) => `${Math.round(v * 100)}%`,
  grain: (v) => `${Math.round(v * 200)}%`,
  radius: (v) => `${v}px`,
  gap: (v) => `${v}px`,
}

function applyAppearance(settings) {
  look = settings
  const root = document.documentElement.style
  root.setProperty('--accent', settings.accent)
  root.setProperty('--c1', settings.colors[0])
  root.setProperty('--c2', settings.colors[1])
  root.setProperty('--angle', `${settings.angle}deg`)
  root.setProperty('--radius', `${settings.radius}px`)
  root.setProperty('--gap', `${settings.gap}px`)
  syncCustomize()
}

/** Coalesces rapid slider/color changes into one update per frame. */
function sendLook(partial) {
  const first = !pendingLook
  pendingLook = { ...pendingLook, ...partial }
  if (!first) return
  requestAnimationFrame(() => {
    api.send('appearance', pendingLook)
    pendingLook = null
  })
}

function setSliderFill(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100
  input.style.setProperty('--fill', `${pct}%`)
  input.nextElementSibling.textContent = SLIDERS[input.id.slice(3)](Number(input.value))
}

function syncCustomize() {
  if (!look) return
  for (const btn of document.querySelectorAll('.cz-preset')) btn.classList.toggle('selected', btn.dataset.id === look.theme)
  for (const btn of document.querySelectorAll('.cz-accent')) btn.classList.toggle('selected', btn.dataset.color === look.accent)
  for (const btn of document.querySelectorAll('#cz-material button')) btn.classList.toggle('selected', btn.dataset.material === look.material)
  $('#cz-focus').classList.toggle('on', look.autoHide)
  $('#cz-fullscreen').classList.toggle('on', look.fullscreen)
  if (document.activeElement !== $('#cz-c1')) $('#cz-c1').value = look.colors[0]
  if (document.activeElement !== $('#cz-c2')) $('#cz-c2').value = look.colors[1]
  for (const key of Object.keys(SLIDERS)) {
    const input = $(`#cz-${key}`)
    if (document.activeElement !== input) input.value = look[key]
    setSliderFill(input)
  }
}

function buildCustomize({ presets, accents, materials }) {
  $('#cz-presets').replaceChildren(
    ...presets.map((p) => {
      const btn = document.createElement('button')
      btn.className = 'cz-preset'
      btn.dataset.id = p.id
      btn.title = p.name
      btn.style.background = `linear-gradient(135deg, ${p.colors[0]}, ${p.colors[1]})`
      btn.innerHTML = `<span>${escapeHtml(p.name)}</span>`
      btn.addEventListener('click', () => sendLook({ theme: p.id, colors: p.colors }))
      return btn
    }),
  )

  $('#cz-accents').replaceChildren(
    ...accents.map((color) => {
      const btn = document.createElement('button')
      btn.className = 'cz-accent'
      btn.dataset.color = color
      btn.style.background = color
      btn.addEventListener('click', () => sendLook({ accent: color }))
      return btn
    }),
  )

  $('#cz-material-row').hidden = materials.length === 0
  $('#cz-material').replaceChildren(
    ...materials.map((material) => {
      const btn = document.createElement('button')
      btn.dataset.material = material
      btn.textContent = material
      btn.addEventListener('click', () => sendLook({ material }))
      return btn
    }),
  )
}

for (const key of Object.keys(SLIDERS)) {
  const input = $(`#cz-${key}`)
  input.addEventListener('input', () => {
    setSliderFill(input)
    sendLook({ [key]: Number(input.value) })
  })
}

for (const id of ['#cz-c1', '#cz-c2']) {
  $(id).addEventListener('input', () => sendLook({ theme: 'custom', colors: [$('#cz-c1').value, $('#cz-c2').value] }))
}

$('#cz-swap').addEventListener('click', () => {
  if (look) sendLook({ theme: 'custom', colors: [look.colors[1], look.colors[0]] })
})
$('#cz-reset').addEventListener('click', () => api.send('appearance-reset'))
$('#cz-focus').addEventListener('click', () => api.send('toggle-focus-mode'))
$('#cz-fullscreen').addEventListener('click', () => look && sendLook({ fullscreen: !look.fullscreen }))

function positionCustomize() {
  const r = $('#customize-btn').getBoundingClientRect()
  const top = r.bottom + 8
  customizePanel.style.top = `${top}px`
  customizePanel.style.left = `${Math.max(8, Math.min(r.right - 300, window.innerWidth - 308))}px`
  customizePanel.style.maxHeight = `${window.innerHeight - top - 12}px`
}

function toggleCustomize(force) {
  const open = force ?? customizePanel.hidden
  if (open) {
    downloadsPanel.hidden = true
    mainPanel.hidden = true
    syncCustomize()
    positionCustomize()
  }
  customizePanel.hidden = !open
  syncExpanded()
}

$('#customize-btn').addEventListener('click', () => toggleCustomize())

api.invoke('appearance').then((catalog) => {
  buildCustomize(catalog)
  applyAppearance(catalog.settings)
})

// ── ⋯ panel ──────────────────────────────────────────────────────────────

const PANEL_UI_ACTIONS = {
  downloads: () => toggleDownloads(true),
  customize: () => toggleCustomize(true),
}
// Actions you'd likely repeat keep the panel open.
const PANEL_STAYS_OPEN = new Set(['zoom-in', 'zoom-out', 'zoom-reset', 'toggle-autohide', 'toggle-fullscreen'])

function syncMainPanel() {
  const tab = activeTab()
  $('#mp-zoom').textContent = `${tab?.zoom ?? 100}%`
  $('#mp-autohide').classList.toggle('on', Boolean(state.focusMode))
  $('#mp-fullscreen').classList.toggle('on', Boolean(state.fullscreen))
  $('[data-action="favorite"]', mainPanel).disabled = !/^https?:/.test(tab?.url ?? '')
  $('[data-action="devtools"]', mainPanel).disabled = !tab
}

function positionMainPanel() {
  const r = $('#menu-btn').getBoundingClientRect()
  const top = r.bottom + 8
  mainPanel.style.top = `${top}px`
  mainPanel.style.left = `${Math.max(8, Math.min(r.right - 290, window.innerWidth - 298))}px`
  mainPanel.style.maxHeight = `${window.innerHeight - top - 12}px`
}

function toggleMainPanel(force) {
  const open = force ?? mainPanel.hidden
  if (open) {
    downloadsPanel.hidden = true
    customizePanel.hidden = true
    syncMainPanel()
    positionMainPanel()
  }
  mainPanel.hidden = !open
  syncExpanded()
}

mainPanel.addEventListener('click', (e) => {
  const button = e.target.closest('[data-action]')
  if (!button || button.disabled) return
  const action = button.dataset.action
  if (!PANEL_STAYS_OPEN.has(action)) toggleMainPanel(false)
  if (PANEL_UI_ACTIONS[action]) PANEL_UI_ACTIONS[action]()
  else api.send('menu-action', action)
})

// ── Menus (drawn here instead of native OS menus) ────────────────────────

const menusEl = $('#menus')
const isMac = api.platform === 'darwin'

function formatAccelerator(accel) {
  if (!accel) return ''
  return accel
    .replace(/CmdOrCtrl|CommandOrControl/g, isMac ? '⌘' : 'Ctrl')
    .replace(/\+(?=.)/g, isMac ? '' : '+')
    .replace(/Shift/g, isMac ? '⇧' : 'Shift')
}

function closeMenuLevels(fromLevel) {
  for (const panel of [...menusEl.children]) {
    if (Number(panel.dataset.level) >= fromLevel) panel.remove()
  }
}

function renderMenuLevel(items, x, y, level, anchor) {
  closeMenuLevels(level)
  const panel = document.createElement('div')
  panel.className = 'panel menu'
  panel.dataset.level = level

  for (const item of items) {
    if (item.type === 'separator') {
      panel.append(Object.assign(document.createElement('div'), { className: 'menu-sep' }))
      continue
    }
    const row = document.createElement('div')
    row.className = `menu-item${item.enabled ? '' : ' disabled'}`
    row.innerHTML = `<span class="menu-check">${item.checked ? ICONS.check : ''}</span>
      <span class="menu-label"></span><span class="menu-accel"></span>${item.submenu ? '<span class="menu-arrow">›</span>' : ''}`
    $('.menu-label', row).textContent = item.label
    if (item.icon) {
      const slot = $('.menu-check', row)
      slot.classList.add('menu-icon')
      const img = Object.assign(document.createElement('img'), { src: item.icon, alt: '' })
      img.onerror = () => (slot.innerHTML = ICONS.globe)
      slot.replaceChildren(img)
    }
    $('.menu-accel', row).textContent = formatAccelerator(item.accelerator)

    row.addEventListener('mouseenter', () => {
      for (const sibling of panel.querySelectorAll('.menu-item.open')) sibling.classList.remove('open')
      if (item.submenu && item.enabled) {
        row.classList.add('open')
        const r = row.getBoundingClientRect()
        renderMenuLevel(item.submenu, r.right + 4, r.top - 5, level + 1, r)
      } else {
        closeMenuLevels(level + 1)
      }
    })
    row.addEventListener('click', () => {
      if (!item.enabled || item.submenu) return
      closeMenus(item.id)
    })
    panel.append(row)
  }

  menusEl.append(panel)
  // Keep it on screen; submenus flip to the left when there's no room on the right.
  const { width, height } = panel.getBoundingClientRect()
  let left = x
  if (left + width > window.innerWidth - 6) left = anchor ? anchor.left - width - 4 : window.innerWidth - width - 6
  const top = Math.max(6, Math.min(y, window.innerHeight - height - 6))
  panel.style.left = `${Math.max(6, left)}px`
  panel.style.top = `${top}px`
}

function openMenu({ items, x, y }) {
  const alreadyExpanded = expanded
  menuOpen = true
  downloadsPanel.hidden = true
  customizePanel.hidden = true
  syncExpanded()
  // The UI view has to grow to the full window before the menu can be measured and placed.
  let rendered = false
  const render = () => {
    if (rendered || !menuOpen) return
    rendered = true
    renderMenuLevel(items, x, y, 0)
  }
  if (alreadyExpanded || window.innerHeight > y + 40) return render()
  window.addEventListener('resize', render, { once: true })
  setTimeout(render, 120)
}

/** Closes all menus; reports the chosen item id (or null when dismissed). */
function closeMenus(selectedId = null) {
  if (!menuOpen) return
  menuOpen = false
  menusEl.replaceChildren()
  api.send('menu-select', selectedId)
  syncExpanded()
}

// ── Prompt cards ─────────────────────────────────────────────────────────

const promptsEl = $('#prompts')

function promptIcon(data) {
  const wrap = document.createElement('div')
  wrap.className = 'prompt-icon'
  const src = data.icon ?? (data.origin ? FAVICON_SERVICE(hostOf(data.origin)) : null)
  if (src) {
    const img = document.createElement('img')
    img.src = src
    if (data.icon) img.className = 'full'
    img.onerror = () => (wrap.innerHTML = ICONS.key)
    wrap.append(img)
  } else {
    wrap.innerHTML = ICONS.puzzle
  }
  return wrap
}

function showPrompt(data) {
  const el = document.createElement('div')
  el.className = 'prompt'

  const head = document.createElement('div')
  head.className = 'prompt-head'
  const text = document.createElement('div')
  text.style.minWidth = '0'
  const title = Object.assign(document.createElement('div'), { className: 'prompt-title', textContent: data.title ?? '' })
  const message = Object.assign(document.createElement('div'), { className: 'prompt-message', textContent: data.message ?? '' })
  text.append(title, message)
  head.append(promptIcon(data), text)
  el.append(head)

  if (data.detail) {
    el.append(Object.assign(document.createElement('div'), { className: 'prompt-detail', textContent: data.detail }))
  }

  let checkbox = null
  if (data.checkbox) {
    const label = document.createElement('label')
    label.className = 'prompt-check'
    checkbox = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(data.checkbox.checked) })
    label.append(checkbox, document.createTextNode(data.checkbox.label))
    el.append(label)
  }

  const buttons = document.createElement('div')
  buttons.className = 'prompt-buttons'
  for (const b of data.buttons ?? []) {
    const btn = Object.assign(document.createElement('button'), { className: `btn ${b.style ?? 'secondary'}`, textContent: b.label })
    btn.addEventListener('click', () => answerPrompt(data.id, b.id, checkbox?.checked))
    buttons.append(btn)
  }
  el.append(buttons)

  prompts.set(data.id, { data, el })
  promptsEl.append(el)
  syncExpanded()
}

function answerPrompt(id, button, checked = false) {
  const entry = prompts.get(id)
  if (!entry) return
  prompts.delete(id)
  api.send('prompt-response', id, button, checked)
  entry.el.classList.add('leaving')
  setTimeout(() => entry.el.remove(), 160)
  syncExpanded()
}

function dismissAllPrompts() {
  for (const [id, { data }] of [...prompts]) answerPrompt(id, data.cancelId)
}

// ── Main process events ──────────────────────────────────────────────────

api.onState((next) => {
  state = next
  render()
})

api.onEvent((type, payload) => {
  switch (type) {
    case 'focus-address':
      beginEdit()
      break
    case 'find-open':
      findInput.focus()
      findInput.select()
      if (findInput.value) api.send('find', findInput.value, { newSession: true, forward: true })
      break
    case 'found':
      showFound(payload)
      break
    case 'downloads':
      downloads = payload
      renderDownloads()
      break
    case 'download-started':
      downloadsBtn.hidden = false
      downloadsBtn.classList.remove('bounce')
      void downloadsBtn.offsetWidth
      downloadsBtn.classList.add('bounce')
      break
    case 'toggle-downloads':
      toggleDownloads()
      break
    case 'flash':
      flash(payload)
      break
    case 'appearance':
      applyAppearance(payload)
      break
    case 'toggle-customize':
      toggleCustomize()
      break
    case 'menu':
      openMenu(payload)
      break
    case 'prompt':
      showPrompt(payload)
      break
  }
})

window.addEventListener('resize', () => {
  if (!suggestionsEl.hidden) showSuggestions()
  if (!downloadsPanel.hidden) positionDownloads()
  if (!customizePanel.hidden) positionCustomize()
  if (!mainPanel.hidden) positionMainPanel()
})

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (menuOpen) return closeMenus()
  if (!mainPanel.hidden) toggleMainPanel(false)
  if (!downloadsPanel.hidden) toggleDownloads(false)
  if (!customizePanel.hidden) toggleCustomize(false)
  if (prompts.size) dismissAllPrompts()
})

api.invoke('state').then((s) => {
  state = s
  render()
})
api.invoke('downloads').then((list) => {
  downloads = list
  renderDownloads()
})
