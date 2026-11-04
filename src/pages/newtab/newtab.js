'use strict'

const $ = (selector) => document.querySelector(selector)
let searchAddress = 'https://duckduckgo.com/?q=%s'
const FAVICON_SERVICE = (host) => `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`
const ICON_SEARCH = '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2L13.5 13.5"/></svg>'
const ICON_CLOSE = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>'
const ICON_PLUS = '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>'

// ── Clock ──────────────────────────────────────────────

function tick() {
  const now = new Date()
  $('#clock').textContent = now
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .replace(/\s?[AP]\.?M\.?$/i, '')
  const hour = now.getHours()
  const part = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
  $('#greeting').textContent = `${part} · ${date}`
  setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50)
}
tick()

// ── Search ─────────────────────────────────────────────

const input = $('#q')
fetch('/api/search')
  .then((res) => res.json())
  .then(({ name, url }) => {
    searchAddress = url
    input.placeholder = `Search with ${name}`
  })
  .catch(() => {})
const suggest = $('#suggest')
let phrases = []
let selected = -1
let typed = ''
let timer = null
let seq = 0

function toUrl(text) {
  const t = text.trim()
  if (!/\s/.test(t)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t
    if (/^localhost(:\d+)?(\/|$)/i.test(t) || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?([/?#].*)?$/.test(t)) return `http://${t}`
    if (/^[^\s/?#:]+\.[a-z][a-z0-9-]{1,62}(:\d+)?([/?#].*)?$/i.test(t)) return `https://${t}`
  }
  return searchAddress.replace('%s', encodeURIComponent(t))
}

function go(text) {
  if (text.trim()) location.href = toUrl(text)
}

function render() {
  if (!phrases.length) {
    suggest.hidden = true
    return
  }
  suggest.innerHTML = ''
  phrases.forEach((phrase, i) => {
    const row = document.createElement('div')
    row.className = `row${i === selected ? ' selected' : ''}`
    row.innerHTML = ICON_SEARCH
    row.append(document.createTextNode(phrase))
    row.addEventListener('mousedown', (e) => e.preventDefault())
    row.addEventListener('click', () => go(phrase))
    suggest.append(row)
  })
  suggest.hidden = false
}

input.addEventListener('input', () => {
  typed = input.value
  selected = -1
  clearTimeout(timer)
  const query = typed.trim()
  if (!query) {
    phrases = []
    render()
    return
  }
  const mine = ++seq
  timer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/suggest?q=${encodeURIComponent(query)}`)
      const list = await res.json()
      if (mine !== seq) return
      phrases = list.slice(0, 7)
      render()
    } catch {}
  }, 100)
})

input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!phrases.length) return
    e.preventDefault()
    const n = phrases.length + 1 // -1 = what was typed
    selected = ((selected + 1 + (e.key === 'ArrowDown' ? 1 : -1) + n) % n) - 1
    input.value = selected === -1 ? typed : phrases[selected]
    render()
  } else if (e.key === 'Escape') {
    phrases = []
    render()
  }
})

input.addEventListener('blur', () => (suggest.hidden = true))
input.addEventListener('focus', () => phrases.length && render())

$('#search').addEventListener('submit', (e) => {
  e.preventDefault()
  go(input.value)
})

// ── Favorites ──────────────────────────────────────────

let favorites = []

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

const TOKEN = document.querySelector('meta[name="glasswing-token"]')?.content ?? ''

async function save() {
  try {
    await fetch('/api/favorites', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-glasswing-token': TOKEN },
      body: JSON.stringify(favorites),
    })
  } catch {
    loadFavorites() // show what's actually saved
  }
}

function loadFavorites() {
  return fetch('/api/favorites')
    .then((r) => r.json())
    .then((list) => {
      favorites = list
      renderFavorites()
    })
    .catch(() => renderFavorites())
}

// The favorites bar and the star button change the same list. The browser fires this when they do.
window.addEventListener('favorites-changed', loadFavorites)

function tile(fav, index) {
  const a = document.createElement('a')
  a.className = 'fav'
  a.href = fav.url
  a.title = fav.url

  const icon = document.createElement('span')
  icon.className = 'fav-icon'
  const img = document.createElement('img')
  img.alt = ''
  img.src = FAVICON_SERVICE(hostOf(fav.url))
  img.onerror = () => (icon.textContent = (fav.title || hostOf(fav.url)).charAt(0).toUpperCase())
  icon.append(img)

  const label = document.createElement('span')
  label.className = 'fav-label'
  label.textContent = fav.title || hostOf(fav.url)

  const remove = document.createElement('button')
  remove.className = 'fav-remove'
  remove.title = 'Remove'
  remove.innerHTML = ICON_CLOSE
  remove.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    favorites.splice(index, 1)
    renderFavorites()
    save()
  })

  a.append(icon, label, remove)
  return a
}

function renderFavorites() {
  const grid = $('#favorites')
  grid.replaceChildren(...favorites.map(tile))

  const add = document.createElement('a')
  add.className = 'fav add'
  add.href = '#'
  add.innerHTML = `<span class="fav-icon">${ICON_PLUS}</span><span class="fav-label">Add</span>`
  add.addEventListener('click', (e) => {
    e.preventDefault()
    $('#add-form').reset()
    $('#add-dialog').showModal()
  })
  grid.append(add)
}

$('#add-cancel').addEventListener('click', () => $('#add-dialog').close())

$('#add-form').addEventListener('submit', (e) => {
  const raw = $('#add-url').value.trim()
  if (!raw) return e.preventDefault()
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    new URL(url)
  } catch {
    e.preventDefault() // not an address: leave the dialog open so it can be corrected
    $('#add-url').focus()
    return
  }
  favorites.push({ title: $('#add-title').value.trim() || hostOf(url), url })
  renderFavorites()
  save()
})

loadFavorites()
