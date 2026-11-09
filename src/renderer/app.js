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
  camera: '<svg viewBox="0 0 16 16"><rect x="1.8" y="4.2" width="8.6" height="7.6" rx="1.8"/><path d="M10.4 7.2l3.8-2.2v6l-3.8-2.2"/></svg>',
  microphone: '<svg viewBox="0 0 16 16"><rect x="5.9" y="1.8" width="4.2" height="7.6" rx="2.1"/><path d="M3.4 7.8a4.6 4.6 0 0 0 9.2 0M8 12.4v2"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h3.8l1.5 1.5h5.7v6.5h-11z"/></svg>',
  check: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  key: '<svg viewBox="0 0 16 16"><circle cx="5.5" cy="10.5" r="2.75"/><path d="M7.5 8.5L13 3M11 5l1.5 1.5M9.5 6.5L11 8"/></svg>',
  crashed: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.75"/><path d="M6 6.2v.01M10 6.2v.01M5.6 11c1.4-1.3 3.4-1.3 4.8 0"/></svg>',
  shield: '<svg viewBox="0 0 16 16"><path d="M8 1.8l5 1.9v3.8c0 3.2-2.1 5.6-5 6.7-2.9-1.1-5-3.5-5-6.7V3.7z"/></svg>',
  star: '<svg viewBox="0 0 16 16"><path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11.1l-3.4 1.8.7-3.8-2.8-2.6 3.8-.5z"/></svg>',
}

const FAVICON_SERVICE = (host) => `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`
const searchName = () => state.search?.name ?? 'the web'
const placeholder = () => `Search ${searchName()} or enter website name`

document.body.classList.add(`platform-${api.platform}`)

// ── State ────────────────────────────────────────────────────────────────

let state = { tabs: [], activeId: null }
const tabEls = new Map()
const loadingBefore = new Map()
let editing = false
let flashText = null
let dragState = null
let tabDragOut = false // a tab has been pulled out of the strip
let menuOpen = false
const prompts = new Map() // id → { data, el }

const TAB_PULL_MARGIN = 34 // how far past the tab strip a tab goes before it's been pulled out
const TAB_CLICK_MS = 180 // a press this short is a click, even if the hand moved during it
const TAB_DOUBLE_CLICK_MS = 450
let lastTabClick = { id: null, at: 0 }
const strip = $('#tabstrip')
const dragZones = $('#drag-zones')
const dropMarker = $('#drop-marker')
const address = $('#address-template').content.firstElementChild.cloneNode(true)
const addressInput = $('#address-input', address)
const addressText = $('#address-text', address)
const addressIcon = $('#address-icon', address)
const addressCapture = $('#address-capture', address)
const addressAudio = $('#address-audio', address)
const zoomPill = $('#zoom-pill', address)
const reloadBtn = $('#reload', address)
const starBtn = $('#star', address)
const suggestionsEl = $('#suggestions')
const downloadsPanel = $('#downloads-panel')
const customizePanel = $('#customize-panel')
const mainPanel = $('#main-panel')
const downloadsBtn = $('#downloads-btn')
const shieldPanel = $('#shield-panel')
const shieldBtn = $('#shield-btn')
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
  const engine = state.search
  if (!u || !engine) return null
  const onEngine = u.hostname === engine.host || u.hostname.endsWith(`.${engine.host}`)
  return (onEngine && u.pathname === engine.path && u.searchParams.get(engine.param)) || null
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
    <span class="capture" hidden></span>
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

/** The speaker: on a background tab's button, or in the address field for the active one. */
function updateAudio(button, tab) {
  const show = tab.audible || tab.muted
  button.hidden = !show
  if (!show) return
  if (button.dataset.state !== String(tab.muted)) {
    button.innerHTML = tab.muted ? ICONS.muted : ICONS.speaker
    button.dataset.state = String(tab.muted)
  }
  button.title = tab.muted ? 'Unmute Tab' : 'Mute Tab'
}

function updateCapture(container, tab) {
  const key = `${tab.camera}${tab.microphone}`
  container.hidden = !tab.camera && !tab.microphone
  if (container.dataset.state === key) return
  container.dataset.state = key
  container.innerHTML = (tab.camera ? ICONS.camera : '') + (tab.microphone ? ICONS.microphone : '')
  container.title = tab.camera && tab.microphone ? 'Using your camera and microphone' : tab.camera ? 'Using your camera' : 'Using your microphone'
}

function updateTabEl(el, tab) {
  const isActive = tab.id === state.activeId
  el.classList.toggle('active', isActive)
  el.classList.toggle('loading', tab.loading)
  el.classList.toggle('sleeping', Boolean(tab.sleeping))
  el.classList.toggle('split-left', tab.split === 'left')
  el.classList.toggle('split-right', tab.split === 'right')
  el.classList.toggle('split-visible', tab.splitPartner === state.activeId)
  el.title = isActive ? '' : tab.title
  const group = groupOf(tab)
  el.classList.toggle('grouped', Boolean(group))
  el.classList.toggle('group-hidden', Boolean(group?.collapsed))
  if (group) el.dataset.groupColor = group.color
  else delete el.dataset.groupColor

  const title = $('.tab-title', el)
  const text = isNewTabUrl(tab.url) && !tab.loading ? 'New Tab' : tab.title
  if (title.textContent !== text) title.textContent = text

  const icon = $('.tab-icon', el)
  if (tab.crashed) setIcon(icon, { fallback: ICONS.crashed })
  else setIcon(icon, { favicon: tab.favicon })

  updateCapture($('.capture', el), tab)
  updateAudio($('.tab-audio', el), tab)

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

// ── Tab groups ───────────────────────────────────────────────────────────

const groupEls = new Map()

function groupOf(tab) {
  return tab.group == null ? null : state.groups?.find((g) => g.id === tab.group) ?? null
}

function createGroupEl(id) {
  const el = document.createElement('button')
  el.className = 'tab-group'
  el.tabIndex = -1
  el.innerHTML = `<svg class="tab-group-arrow" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" /></svg><span class="tab-group-name"></span><span class="tab-group-count"></span>`
  el.addEventListener('click', () => api.send('group-toggle', id))
  el.addEventListener('mousedown', (e) => e.preventDefault()) // the address bar keeps the keyboard
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    api.send('group-menu', id, e.clientX, e.clientY)
  })
  groupEls.set(id, el)
  return el
}

function updateGroupEl(el, group) {
  el.dataset.groupColor = group.color
  el.classList.toggle('collapsed', group.collapsed)
  $('.tab-group-name', el).textContent = group.name
  $('.tab-group-count', el).textContent = group.collapsed ? group.count : ''
  el.title = `${group.collapsed ? 'Show' : 'Hide'} ${group.count === 1 ? '1 tab' : `${group.count} tabs`}`
}

/** The group whose stretch of the strip `x` is over, unless it's hidden away. `el`, the tab being moved, doesn't count. */
function groupAtPoint(x, el) {
  for (const [id, chip] of groupEls) {
    if (chip.classList.contains('collapsed')) continue
    const tabs = [...tabEls.entries()].filter(([tabId, tabEl]) => tabEl !== el && state.tabs.find((t) => t.id === tabId)?.group === id).map(([, tabEl]) => tabEl)
    const right = Math.max(chip.getBoundingClientRect().right, ...tabs.map((tabEl) => tabEl.getBoundingClientRect().right))
    if (x >= chip.getBoundingClientRect().left && x <= right) return id
  }
  return null
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
  dragState?.cancel?.() // an earlier press whose release never arrived mustn't turn this click into a drag

  // Selecting waits for the mouse button to come up. A tab dragged out for split view has to leave
  // the page you're looking at on screen, to split with.
  const startX = e.clientX
  const startY = e.clientY
  const pressedAt = performance.now()
  let waitForHold = null
  dragState = { id, el, moved: false, out: false }

  const others = () => [...strip.querySelectorAll(':scope > .tab')].filter((c) => c !== el)
  // Counts tabs, including those hidden in a group. A group's label marks where that group starts.
  const targetIndex = (x) => {
    let index = 0
    for (const c of strip.children) {
      if (c === el) continue
      const r = c.getBoundingClientRect()
      if (r.width && x < r.left + r.width / 2) return index
      if (c.classList.contains('tab')) index += 1
    }
    return index
  }

  const isOutOfStrip = (ev) =>
    ev.clientY > panelTop() + TAB_PULL_MARGIN ||
    ev.clientY < -TAB_PULL_MARGIN ||
    ev.clientX < -TAB_PULL_MARGIN ||
    ev.clientX > window.innerWidth + TAB_PULL_MARGIN

  const setOut = (out) => {
    if (dragState.out === out) return
    dragState.out = out
    tabDragOut = out
    el.classList.toggle('pulled-out', out)
    el.classList.remove('dragging')
    el.style.transform = ''
    if (!out) dragZones.hidden = true
    syncExpanded()
    api.send(out ? 'tab-drag-start' : 'tab-drag-cancel', id)
  }

  const onMove = (ev) => {
    if (ev.buttons === 0) return onUp(ev) // the button came up somewhere we couldn't see it
    const dx = ev.clientX - startX
    const dy = ev.clientY - startY
    if (!dragState.moved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return
    if (!dragState.moved) {
      // Hands move during a quick click. It's only a drag if the button is still down a moment later.
      const heldFor = performance.now() - pressedAt
      if (heldFor < TAB_CLICK_MS) {
        clearTimeout(waitForHold)
        waitForHold = setTimeout(() => dragState?.id === id && onMove(ev), TAB_CLICK_MS - heldFor)
        return
      }
    }
    dragState.moved = true
    if (isOutOfStrip(ev)) return setOut(true)
    setOut(false)
    if (state.tabs.length < 2) return
    el.classList.add('dragging')
    el.style.transform = `translateX(${dx}px)`
  }

  const stopListening = () => {
    clearTimeout(waitForHold)
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    window.removeEventListener('blur', onBlur)
  }

  const onUp = (ev) => {
    stopListening()
    const { moved, out } = dragState
    if (out) {
      finishPull(el)
      api.send('tab-drag-end')
      return
    }
    dragState = null
    el.classList.remove('dragging')
    el.style.transform = ''
    if (!tabEls.has(id)) return // closed while being dragged
    if (moved && state.tabs.length > 1) {
      const index = targetIndex(ev.clientX)
      const group = groupAtPoint(ev.clientX, el)
      strip.insertBefore(el, others()[index] ?? null)
      api.send('move-tab', id, index, group)
    }
    // Clicking the tab you're on leaves the keyboard where it was. Double-click it to type an address.
    const now = performance.now()
    const second = !moved && lastTabClick.id === id && now - lastTabClick.at < TAB_DOUBLE_CLICK_MS
    lastTabClick = second || moved ? { id: null, at: 0 } : { id, at: now }
    if (!wasActive) api.send('select-tab', id)
    else if (second) beginEdit()
  }

  const cancel = () => {
    stopListening()
    const { out } = dragState
    if (out) {
      finishPull(el)
      api.send('tab-drag-cancel')
    } else {
      dragState = null
      el.classList.remove('dragging')
      el.style.transform = ''
    }
  }
  dragState.cancel = cancel

  // A page can take the keyboard in the middle of a click, and that's no reason to lose the click.
  const onBlur = () => {
    if (dragState?.moved) cancel()
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  window.addEventListener('blur', onBlur)
}

function finishPull(el) {
  dragState = null
  tabDragOut = false
  el.classList.remove('pulled-out')
  dragZones.hidden = true
  syncExpanded()
}

function showDragZones({ offer, zone }) {
  dragZones.hidden = !offer || !tabDragOut
  for (const el of dragZones.children) el.classList.toggle('over', el.dataset.zone === zone)
}

/** A tab from another window is being held over this one: show where it would land. */
function showDropMarker(x) {
  const body = document.body.classList
  body.toggle('drop-target', x != null)
  dropMarker.hidden = x == null
  if (x == null) return
  const tabs = [...strip.querySelectorAll(':scope > .tab')]
  let index = tabs.findIndex((c) => {
    const r = c.getBoundingClientRect()
    return x < r.left + r.width / 2
  })
  if (index === -1) index = tabs.length
  const before = tabs[index]?.getBoundingClientRect()
  const after = tabs.slice(0, index).findLast((c) => c.offsetWidth)?.getBoundingClientRect()
  dropMarker.style.left = `${before ? before.left - 4 : (after?.right ?? strip.getBoundingClientRect().left) + 2}px`
  api.send('tab-drop-index', index)
}

// ── Rendering ────────────────────────────────────────────────────────────

const TAB_MOTION_MS = 170
let groupsBefore = '[]'

/** Tabs that aren't being looked at, or a system that asks for less motion, don't need animating. */
function tabStripOnScreen() {
  if (dragState || matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  return !state.toolbarAway || document.body.classList.contains('revealed')
}

function tabPlaces() {
  return new Map([...strip.children].map((el) => [el, el.getBoundingClientRect().left]))
}

/** The other tabs glide from where they were into where they've ended up. */
function tabsGlide(placesBefore) {
  for (const [el, left] of placesBefore) {
    if (!el.isConnected) continue
    const moved = left - el.getBoundingClientRect().left
    if (Math.abs(moved) < 1) continue
    el.animate([{ transform: `translateX(${moved}px)` }, { transform: 'none' }], { duration: TAB_MOTION_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
  }
}

/** A picture of the closing tab stays where it was for a moment, shrinking away. It takes no clicks. */
function tabLeaves(el) {
  const rect = el.getBoundingClientRect()
  if (!rect.width) return
  const copy = el.cloneNode(true)
  copy.querySelectorAll('[id]').forEach((part) => part.removeAttribute('id'))
  copy.classList.remove('editing')
  copy.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0;z-index:5;pointer-events:none`
  document.body.append(copy)
  copy.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.82) translateY(-5px)' }], { duration: TAB_MOTION_MS, easing: 'ease-in', fill: 'forwards' })
  setTimeout(() => copy.remove(), TAB_MOTION_MS) // a timer, because animations wait while a window is out of sight
}

function render() {
  const body = document.body.classList
  body.toggle('private', Boolean(state.private))
  body.toggle('single-tab', state.tabs.length <= 1)
  body.toggle('chrome-hidden', Boolean(state.chromeHidden))
  body.toggle('revealed', Boolean(state.revealed))
  body.toggle('toolbar-away', Boolean(state.toolbarAway))
  body.toggle('find-open', Boolean(state.findOpen))
  body.toggle('fullscreen', Boolean(state.fullscreen))
  body.toggle('blurred', state.focused === false)
  body.toggle('page-loading', Boolean(activeTab()?.loading))
  const favbarWasOpen = body.contains('favbar-open')
  body.toggle('favbar-open', Boolean(state.favoritesBar))
  if (state.favoritesBar && !favbarWasOpen) fitFavorites()

  const tab = activeTab()
  $('#back').disabled = !tab?.canGoBack
  $('#forward').disabled = !tab?.canGoForward

  // Reconcile tab elements by id.
  const ids = new Set(state.tabs.map((t) => t.id))
  const tabsChanged = state.tabs.some((t) => !tabEls.has(t.id)) || [...tabEls.keys()].some((id) => !ids.has(id))
  const groupsNow = JSON.stringify((state.groups ?? []).map((g) => [g.id, g.collapsed]))
  const groupsChanged = groupsNow !== groupsBefore
  groupsBefore = groupsNow
  const animate = (tabsChanged || groupsChanged) && tabEls.size > 0 && tabStripOnScreen()
  const placesBefore = animate ? tabPlaces() : null
  for (const [id, el] of tabEls) {
    if (!ids.has(id)) {
      if (animate) tabLeaves(el)
      el.remove()
      tabEls.delete(id)
      loadingBefore.delete(id)
    }
  }
  const groupIds = new Set((state.groups ?? []).map((g) => g.id))
  for (const [id, el] of groupEls) {
    if (groupIds.has(id)) continue
    el.remove()
    groupEls.delete(id)
  }
  // Each group's label comes just before its first tab.
  const wanted = []
  const appearing = []
  let lastGroup = null
  for (const t of state.tabs) {
    const group = groupOf(t)
    if (group && group.id !== lastGroup) {
      const isNew = !groupEls.has(group.id)
      const chip = groupEls.get(group.id) ?? createGroupEl(group.id)
      updateGroupEl(chip, group)
      wanted.push(chip)
      if (isNew) appearing.push(chip)
    }
    lastGroup = group?.id ?? null
    const isNew = !tabEls.has(t.id)
    const el = tabEls.get(t.id) ?? createTabEl(t.id)
    const wasHidden = el.classList.contains('group-hidden')
    updateTabEl(el, t)
    wanted.push(el)
    if (isNew || (wasHidden && !el.classList.contains('group-hidden'))) appearing.push(el)
  }
  if (!dragState) wanted.forEach((el, i) => {
    if (strip.children[i] !== el) strip.insertBefore(el, strip.children[i] ?? null)
  })
  if (animate) for (const el of appearing) el.animate([{ opacity: 0, transform: 'scale(0.82)' }, { opacity: 1, transform: 'none' }], { duration: TAB_MOTION_MS, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.1)' })
  if (!mainPanel.hidden) syncMainPanel()

  const el = activeEl()
  if (el && address.parentElement !== el) {
    if (editing) endEdit()
    el.appendChild(address)
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  if (placesBefore) tabsGlide(placesBefore)
  updateAddress()
  renderShield()
  reportFloatingRects()
}

function updateAddress() {
  const tab = activeTab()
  if (!tab) return
  const info = displayInfo(tab)

  address.classList.toggle('placeholder', !info.text && !flashText)
  address.classList.toggle('flash', Boolean(flashText))
  addressText.textContent = flashText ?? (info.text || placeholder())
  addressInput.placeholder = placeholder()

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
    const fallback = host === 'history' ? ICONS.clock : host === 'passwords' ? ICONS.key : host === 'protection' ? ICONS.shield : ICONS.puzzle
    setIcon(addressIcon, { favicon: tab.favicon, fallback })
  } else {
    setIcon(addressIcon, { favicon: tab.favicon, fallback: info.kind === 'secure' ? ICONS.lock : ICONS.globe })
  }
  if (info.kind !== 'insecure') addressIcon.title = ''

  updateCapture(addressCapture, tab)
  updateAudio(addressAudio, tab)

  zoomPill.hidden = !tab.zoom || tab.zoom === 100
  zoomPill.textContent = `${tab.zoom}%`
  reloadBtn.title = tab.loading ? 'Stop' : 'Reload'
  reloadBtn.hidden = info.kind === 'empty'

  const isFavorite = favoriteUrls.has(tab.url)
  starBtn.hidden = !/^https?:/.test(tab.url)
  starBtn.classList.toggle('on', isFavorite)
  starBtn.title = `${isFavorite ? 'Remove from' : 'Add to'} Favorites (Ctrl+D)`
}

// ── Address editing & suggestions ────────────────────────────────────────

let typed = ''
let originalValue = ''
let items = []
let selected = 0
let local = { tabs: [], favorites: [], history: [], completion: null }
let remote = []
let suggestSeq = 0
let remoteTimer = null

function beginEdit() {
  const tab = activeTab()
  if (!tab) return
  if (!editing) {
    editing = true
    api.send('hold', true)
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
  api.send('hold', false)
  hideSuggestions()
  updateAddress()
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
    local = { tabs: [], favorites: [], history: [], completion: null }
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
    sub: isUrl ? 'Go to site' : `${searchName()} Search`,
  })

  if (local.tabs.length) {
    list.push({ section: 'Switch to Tab' })
    for (const t of local.tabs) {
      list.push({ kind: 'tab', id: t.id, icon: ICONS.tab, title: t.title, sub: hostOf(t.url), badge: 'Switch to Tab' })
    }
  }

  if (local.favorites.length) {
    list.push({ section: 'Favorites' })
    for (const f of local.favorites) {
      list.push({ kind: 'url', value: f.url, favicon: FAVICON_SERVICE(hostOf(f.url)), icon: ICONS.star, title: f.title || hostOf(f.url), sub: f.url.replace(/^https?:\/\/(www\.)?/, '') })
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
    list.push({ section: `${searchName()} Suggestions` })
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
  suggestionsEl.style.top = `${panelTop()}px`
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

starBtn.addEventListener('mousedown', (e) => e.stopPropagation())
starBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  api.send('favorite-toggle')
})

addressAudio.addEventListener('mousedown', (e) => e.stopPropagation())
addressAudio.addEventListener('click', (e) => {
  e.stopPropagation()
  api.send('toggle-mute', state.activeId)
})

zoomPill.addEventListener('mousedown', (e) => e.stopPropagation())
zoomPill.addEventListener('click', (e) => {
  e.stopPropagation()
  api.send('zoom-reset')
})

let flashTimer = null

function flash(message) {
  flashText = message
  updateAddress()
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
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
    !shieldPanel.hidden ||
    menuOpen ||
    tabDragOut ||
    prompts.size > 0
  if (want === expanded) return
  expanded = want
  document.body.classList.toggle('expanded', want)
  api.send('expand', want)
}

/**
 * Where dropdowns start: just below the toolbar row. Measured from layout rather than from the
 * elements on screen, which may be above the window while they're slid away.
 */
function panelTop() {
  const toolbar = $('#toolbar')
  return toolbar.offsetTop + toolbar.offsetHeight
}

$('#scrim').addEventListener('mousedown', (e) => {
  e.preventDefault()
  // A menu opened from a text field closes on its own, leaving the field in use.
  if (menuOpen) {
    closeMenus()
    return
  }
  downloadsPanel.hidden = true
  customizePanel.hidden = true
  mainPanel.hidden = true
  shieldPanel.hidden = true
  dismissAllPrompts()
  if (editing) addressInput.blur()
  api.send('focus-page')
  hideSuggestions()
  syncExpanded()
})

// ── Clicks on the empty parts of the view ────────────────────────────────

// With auto-hide on, this view is a rectangle over the top of the page. Where nothing is drawn in it,
// a click belongs to the page underneath.
let pagePress = null

window.addEventListener('mousedown', (e) => {
  const empty = e.target === document.body || e.target === document.documentElement
  if (!empty || !state.chromeHidden || expanded) return
  e.preventDefault()
  pagePress = { button: e.button }
  api.send('page-mouse', 'mouseDown', e.clientX, e.clientY, e.button, e.detail)
})

function endPagePress(e) {
  const { button } = pagePress
  pagePress = null
  api.send('page-mouse', 'mouseUp', e.clientX, e.clientY, button, e.detail || 1)
}

window.addEventListener('mousemove', (e) => {
  if (!pagePress) return
  // Nothing held any more: the release happened somewhere this view never heard about it.
  if (e.buttons === 0) endPagePress(e)
  else api.send('page-mouse', 'mouseMove', e.clientX, e.clientY, pagePress.button, 0)
})

window.addEventListener('mouseup', (e) => {
  if (pagePress?.button === e.button) endPagePress(e)
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

// ── Auto-hide ────────────────────────────────────────────────────────────

let rectsTimer = null
let lastRects = ''

/**
 * Auto-hide runs in the main process, which watches the pointer (see watchPointer in shell.js).
 * It's told where the floating elements are, so that the empty space between them doesn't count as
 * "using the toolbar" and the page beneath becomes clickable again.
 */
function reportFloatingRects() {
  clearTimeout(rectsTimer)
  rectsTimer = setTimeout(() => {
    if (!state.chromeHidden || !state.revealed) return // only meaningful once they've slid in
    const rects = [...document.querySelectorAll('#left-pill, #right-pill, #fav-pill, #find-pill, .tab, .tab-group')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }))
    const key = JSON.stringify(rects)
    if (key === lastRects) return
    lastRects = key
    api.send('floating-rects', rects)
  }, 340) // just after the slide-in animation
}

// A mouse wheel scrolls the tabs sideways when there are too many to fit.
strip.addEventListener('wheel', (e) => {
  if (e.deltaY && !e.deltaX) strip.scrollLeft += e.deltaY
  reportFloatingRects()
}, { passive: true })

// ── Favorites bar ────────────────────────────────────────────────────────

const favItems = $('#fav-items')
const favMore = $('#fav-more')
let favorites = []
let favoriteUrls = new Set()
let favOverflowFrom = 0

function setFavorites(list) {
  favorites = list
  favoriteUrls = new Set(list.map((f) => f.url))
  favItems.replaceChildren(...list.map(createFavoriteEl))
  fitFavorites()
  updateAddress()
  if (!mainPanel.hidden) syncMainPanel()
}

function createFavoriteEl(favorite) {
  const el = document.createElement('button')
  el.className = 'fav-item'
  el.tabIndex = -1
  el.title = favorite.title ? `${favorite.title}\n${favorite.url}` : favorite.url
  const icon = Object.assign(document.createElement('span'), { className: 'fav-icon' })
  setIcon(icon, { favicon: FAVICON_SERVICE(hostOf(favorite.url)) })
  const title = Object.assign(document.createElement('span'), { className: 'fav-title', textContent: favorite.title || hostOf(favorite.url) })
  el.append(icon, title)

  el.addEventListener('mousedown', (e) => onFavoriteMouseDown(e, favorite, el))
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) api.send('navigate', favorite.url, { newTab: true })
  })
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    api.send('favorite-menu', favorite.url, e.clientX, e.clientY)
  })
  return el
}

function onFavoriteMouseDown(e, favorite, el) {
  if (e.button === 1) e.preventDefault() // no autoscroll
  if (e.button !== 0) return
  e.preventDefault()

  const startX = e.clientX
  let moved = false
  const others = () => [...favItems.children].filter((c) => c !== el && !c.hidden)

  const onMove = (ev) => {
    const dx = ev.clientX - startX
    if (!moved && Math.abs(dx) < 5) return
    moved = true
    el.classList.add('dragging')
    el.style.transform = `translateX(${dx}px)`
  }
  const onUp = (ev) => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    el.classList.remove('dragging')
    el.style.transform = ''
    if (!moved) {
      api.send('navigate', favorite.url, { newTab: ev.ctrlKey || ev.metaKey })
      return
    }
    const list = others()
    const found = list.findIndex((c) => {
      const r = c.getBoundingClientRect()
      return ev.clientX < r.left + r.width / 2
    })
    const index = found === -1 ? list.length : found
    favItems.insertBefore(el, list[index] ?? null)
    api.send('favorite-move', favorite.url, index)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

/** Shows as many favorites as fit; the rest go behind the » button. */
function fitFavorites() {
  const items = [...favItems.children]
  for (const el of items) el.hidden = false
  favMore.hidden = true
  favOverflowFrom = items.length
  if (!document.body.classList.contains('favbar-open') || !items.length) return reportFloatingRects()

  const GAP = 2
  const available = window.innerWidth - 16 - 8 // window margins and the pill's own padding
  const widths = items.map((el) => el.offsetWidth)
  const total = widths.reduce((sum, w) => sum + w + GAP, -GAP)
  if (total > available) {
    const room = available - 30 // the » button
    let used = 0
    let count = 0
    for (const w of widths) {
      if (used + w + GAP > room) break
      used += w + GAP
      count += 1
    }
    favOverflowFrom = count
    items.slice(count).forEach((el) => (el.hidden = true))
    favMore.hidden = false
  }
  reportFloatingRects()
}

favMore.addEventListener('click', () => {
  const r = favMore.getBoundingClientRect()
  api.send('favorites-overflow', favOverflowFrom, Math.max(8, r.right - 230), r.bottom + 6)
})

api.invoke('favorites').then(setFavorites)

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
  // The button only exists once there's a download; until then line up with the ⋯ button.
  const anchor = downloadsBtn.hidden ? $('#menu-btn') : downloadsBtn
  const r = anchor.getBoundingClientRect()
  downloadsPanel.style.top = `${panelTop()}px`
  downloadsPanel.style.left = `${Math.max(8, Math.min(r.right - 340, window.innerWidth - 348))}px`
}

function toggleDownloads(force) {
  const open = force ?? downloadsPanel.hidden
  if (open) {
    customizePanel.hidden = true
    mainPanel.hidden = true
    shieldPanel.hidden = true
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
  $('#cz-favbar').classList.toggle('on', look.favoritesBar)
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
$('#cz-favbar').addEventListener('click', () => look && sendLook({ favoritesBar: !look.favoritesBar }))

function positionCustomize() {
  const r = $('#customize-btn').getBoundingClientRect()
  const top = panelTop()
  customizePanel.style.top = `${top}px`
  customizePanel.style.left = `${Math.max(8, Math.min(r.right - 300, window.innerWidth - 308))}px`
  customizePanel.style.maxHeight = `${window.innerHeight - top - 12}px`
}

function toggleCustomize(force) {
  const open = force ?? customizePanel.hidden
  if (open) {
    downloadsPanel.hidden = true
    mainPanel.hidden = true
    shieldPanel.hidden = true
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

// ── Ad and tracker blocking ──────────────────────────────────────────────

const SHIELD_STATUS = {
  loading: 'Downloading filter lists…',
  unavailable: 'Couldn’t download filter lists. Trying again soon.',
}

function renderShield() {
  const p = state.protection
  if (!p) return
  const blocked = activeTab()?.blocked ?? { ads: 0, trackers: 0 }
  const total = blocked.ads + blocked.trackers
  const off = (!p.ads && !p.trackers) || p.allowed

  shieldBtn.classList.toggle('off', off)
  const badge = $('#shield-count')
  badge.hidden = off || total === 0
  badge.textContent = total > 99 ? '99+' : String(total)

  if (shieldPanel.hidden) return
  $('#shield-ads-switch').classList.toggle('on', p.ads)
  $('#shield-trackers-switch').classList.toggle('on', p.trackers)
  $('#shield-ads').textContent = blocked.ads ? String(blocked.ads) : ''
  $('#shield-trackers').textContent = blocked.trackers ? String(blocked.trackers) : ''
  $('#shield-total').textContent = total ? `${total} blocked on this page` : ''
  $('#shield-site-row').hidden = !p.site
  $('#shield-site').textContent = p.site ? `On for ${p.site}` : ''
  $('#shield-site-switch').classList.toggle('on', !p.allowed)
  const statusEl = $('#shield-status')
  statusEl.textContent = SHIELD_STATUS[p.status] ?? ''
  statusEl.hidden = !SHIELD_STATUS[p.status]
}

function positionShield() {
  const r = shieldBtn.getBoundingClientRect()
  shieldPanel.style.top = `${panelTop()}px`
  shieldPanel.style.left = `${Math.max(8, Math.min(r.right - 280, window.innerWidth - 288))}px`
}

function toggleShield(force) {
  const open = force ?? shieldPanel.hidden
  if (open) {
    downloadsPanel.hidden = true
    customizePanel.hidden = true
    mainPanel.hidden = true
    positionShield()
  }
  shieldPanel.hidden = !open
  if (open) renderShield()
  syncExpanded()
}

shieldBtn.addEventListener('click', () => toggleShield())
$('#shield-ads-switch').addEventListener('click', () => api.send('protection-set', { ads: !state.protection?.ads }))
$('#shield-trackers-switch').addEventListener('click', () => api.send('protection-set', { trackers: !state.protection?.trackers }))
$('#shield-site-switch').addEventListener('click', () => api.send('protection-toggle-site'))
$('#shield-manage').addEventListener('click', () => {
  toggleShield(false)
  api.send('menu-action', 'protection')
})

// ── ⋯ panel ──────────────────────────────────────────────────────────────

const PANEL_UI_ACTIONS = {
  downloads: () => toggleDownloads(true),
  customize: () => toggleCustomize(true),
}
// Actions you'd likely repeat keep the panel open.
const PANEL_STAYS_OPEN = new Set(['zoom-in', 'zoom-out', 'zoom-reset', 'toggle-autohide', 'toggle-favorites-bar', 'toggle-protection', 'toggle-sleep-tabs', 'toggle-split-links', 'toggle-email-codes', 'toggle-graphics', 'toggle-fullscreen'])

function syncMainPanel() {
  const tab = activeTab()
  $('#mp-zoom').textContent = `${tab?.zoom ?? 100}%`
  $('#mp-autohide').classList.toggle('on', Boolean(state.focusMode))
  $('#mp-fullscreen').classList.toggle('on', Boolean(state.fullscreen))
  $('#mp-favbar').classList.toggle('on', Boolean(state.favoritesBarEnabled))
  $('#mp-protection').classList.toggle('on', Boolean(state.protection?.ads || state.protection?.trackers))
  $('#mp-sleep-tabs').classList.toggle('on', Boolean(state.sleepTabs))
  $('#mp-split-links').classList.toggle('on', Boolean(state.splitLinks))
  $('#mp-email-codes').classList.toggle('on', Boolean(state.emailCodes))
  $('#mp-graphics').classList.toggle('on', Boolean(state.graphics))
  $('#mp-split-label').textContent = tab?.split ? 'Separate Split View' : 'Split View'
  $('#mp-favorite-label').textContent = `${favoriteUrls.has(tab?.url) ? 'Remove from' : 'Add to'} Favorites`
  $('[data-action="favorite"]', mainPanel).disabled = !/^https?:/.test(tab?.url ?? '')
  $('[data-action="devtools"]', mainPanel).disabled = !tab
}

function positionMainPanel() {
  const r = $('#menu-btn').getBoundingClientRect()
  const top = panelTop()
  mainPanel.style.top = `${top}px`
  mainPanel.style.left = `${Math.max(8, Math.min(r.right - 290, window.innerWidth - 298))}px`
  mainPanel.style.maxHeight = `${window.innerHeight - top - 12}px`
}

function toggleMainPanel(force) {
  const open = force ?? mainPanel.hidden
  if (open) {
    downloadsPanel.hidden = true
    customizePanel.hidden = true
    shieldPanel.hidden = true
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
// Clicking a menu mustn't take focus from the text field it may be acting on.
menusEl.addEventListener('mousedown', (e) => e.preventDefault())
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
  shieldPanel.hidden = true
  syncExpanded()
  // The UI view has to grow to the full window before the menu can be measured and placed.
  let rendered = false
  const render = () => {
    if (rendered || !menuOpen) return
    rendered = true
    renderMenuLevel(items, x, y, 0)
  }
  if (alreadyExpanded) return render()
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

  const inputs = new Map()
  for (const field of data.fields ?? []) {
    const label = Object.assign(document.createElement('label'), { className: 'prompt-field', textContent: field.label })
    const input = Object.assign(document.createElement('input'), { type: field.type === 'password' ? 'password' : 'text', value: field.value ?? '', placeholder: field.placeholder ?? '', spellcheck: false })
    if (field.type === 'password' && field.value) {
      const row = Object.assign(document.createElement('div'), { className: 'prompt-field-row' })
      const reveal = Object.assign(document.createElement('button'), { type: 'button', className: 'btn secondary prompt-reveal', textContent: 'Show' })
      reveal.addEventListener('click', (e) => {
        e.preventDefault()
        const hidden = input.type === 'password'
        input.type = hidden ? 'text' : 'password'
        reveal.textContent = hidden ? 'Hide' : 'Show'
      })
      row.append(input, reveal)
      label.append(row)
    } else {
      label.append(input)
    }
    el.append(label)
    inputs.set(field.id, input)
  }

  const ticks = new Map()
  if (data.checklist) {
    const list = Object.assign(document.createElement('div'), { className: 'prompt-checklist' })
    for (const item of data.checklist) {
      const row = Object.assign(document.createElement('label'), { className: 'prompt-checklist-row' })
      const tick = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true })
      const words = document.createElement('span')
      words.append(
        Object.assign(document.createElement('span'), { className: 'prompt-checklist-label', textContent: item.label }),
        Object.assign(document.createElement('span'), { className: 'prompt-checklist-sub', textContent: item.sub ?? '' }),
      )
      row.append(tick, words)
      list.append(row)
      ticks.set(item.id, tick)
    }
    el.append(list)
  }
  const collect = () => ({
    ...Object.fromEntries([...inputs].map(([id, input]) => [id, input.value])),
    ...(data.checklist ? { picked: [...ticks].filter(([, tick]) => tick.checked).map(([id]) => id) } : {}),
  })

  const buttons = document.createElement('div')
  buttons.className = 'prompt-buttons'
  for (const b of data.buttons ?? []) {
    const btn = Object.assign(document.createElement('button'), { className: `btn ${b.style ?? 'secondary'}`, textContent: b.label })
    btn.addEventListener('click', () => answerPrompt(data.id, b.id, checkbox?.checked, collect()))
    buttons.append(btn)
  }
  el.append(buttons)

  // Enter in a field means the primary button.
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || !['text', 'password'].includes(e.target.type)) return
    const primary = (data.buttons ?? []).find((b) => b.style === 'primary')
    if (primary) answerPrompt(data.id, primary.id, checkbox?.checked, collect())
  })

  prompts.set(data.id, { data, el })
  promptsEl.append(el)
  syncExpanded()

  const first = data.quiet ? null : inputs.values().next().value
  if (first) {
    first.focus()
    first.select()
  }
}

function answerPrompt(id, button, checked = false, values = null) {
  const entry = prompts.get(id)
  if (!entry) return
  prompts.delete(id)
  api.send('prompt-response', id, button, checked, values)
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
      break
    case 'download-landed':
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
    case 'favorites':
      setFavorites(payload)
      break
    case 'tab-drag-zone':
      showDragZones(payload)
      break
    case 'tab-drop-hover':
      showDropMarker(payload)
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
    case 'prompt-close':
      answerPrompt(payload, prompts.get(payload)?.data.cancelId)
      break
  }
})

window.addEventListener('resize', () => {
  if (!suggestionsEl.hidden) showSuggestions()
  if (!downloadsPanel.hidden) positionDownloads()
  if (!customizePanel.hidden) positionCustomize()
  if (!mainPanel.hidden) positionMainPanel()
  if (!shieldPanel.hidden) positionShield()
  fitFavorites()
})

document.addEventListener('contextmenu', (e) => {
  const input = e.target.closest?.('input[type="text"]')
  if (!input) return
  e.preventDefault()
  api.send('input-menu', e.clientX, e.clientY, {
    hasSelection: input.selectionStart !== input.selectionEnd,
    isAddress: input === addressInput,
  })
})

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (dragState?.cancel) return dragState.cancel()
  if (menuOpen) return closeMenus()
  if (!mainPanel.hidden) toggleMainPanel(false)
  if (!downloadsPanel.hidden) toggleDownloads(false)
  if (!customizePanel.hidden) toggleCustomize(false)
  if (!shieldPanel.hidden) toggleShield(false)
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
