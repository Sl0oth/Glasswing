'use strict'

const $ = (selector) => document.querySelector(selector)
const FAVICON_SERVICE = (host) => `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`
const ICON_CLOSE = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>'
const PAGE_SIZE = 200

let items = []
let total = 0
let search = ''
let searchTimer = null

const TOKEN = document.querySelector('meta[name="glasswing-token"]')?.content ?? ''
const json = (url, options) => fetch(url, options).then((r) => r.json())
const send = (url, method, body) =>
  json(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-glasswing-token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  })

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function dayLabel(ts) {
  const date = new Date(ts)
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const full = date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
  if (ts >= startOfToday) return `Today — ${full}`
  if (ts >= startOfToday - 86_400_000) return `Yesterday — ${full}`
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function toast(message) {
  const el = $('#toast')
  el.textContent = message
  el.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => (el.hidden = true), 2200)
}

// ── List ─────────────────────────────────────────────────────────────────

function entryEl(item) {
  const a = document.createElement('a')
  a.className = 'entry'
  a.href = item.url
  a.title = item.url

  const time = document.createElement('span')
  time.className = 'time'
  time.textContent = new Date(item.lastVisit).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  const icon = document.createElement('img')
  icon.alt = ''
  icon.src = FAVICON_SERVICE(hostOf(item.url))
  icon.onerror = () => (icon.style.visibility = 'hidden')

  const title = document.createElement('span')
  title.className = 'entry-title'
  title.textContent = item.title || item.url

  const host = document.createElement('span')
  host.className = 'entry-host'
  host.textContent = hostOf(item.url)

  const remove = document.createElement('button')
  remove.className = 'remove'
  remove.title = 'Remove from history'
  remove.innerHTML = ICON_CLOSE
  remove.addEventListener('click', async (e) => {
    e.preventDefault()
    e.stopPropagation()
    await send(`/api/history?url=${encodeURIComponent(item.url)}`, 'DELETE')
    items = items.filter((i) => i.url !== item.url)
    total -= 1
    render()
  })

  a.append(time, icon, title, host, remove)
  return a
}

function render() {
  const list = $('#list')
  list.replaceChildren()
  if (!items.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = search ? `No history matches “${search}”.` : 'Your history is empty.'
    list.append(empty)
  }
  let lastDay = null
  for (const item of items) {
    const day = dayLabel(item.lastVisit)
    if (day !== lastDay) {
      const heading = document.createElement('div')
      heading.className = 'day'
      heading.textContent = day
      list.append(heading)
      lastDay = day
    }
    list.append(entryEl(item))
  }
  $('#more').hidden = items.length >= total
}

async function load({ append = false } = {}) {
  const offset = append ? items.length : 0
  const page = await json(`/api/history?q=${encodeURIComponent(search)}&offset=${offset}&limit=${PAGE_SIZE}`)
  items = append ? [...items, ...page.items] : page.items
  total = page.total
  render()
}

$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    search = e.target.value.trim()
    load()
  }, 150)
})

$('#more button').addEventListener('click', () => load({ append: true }))

// ── Settings ─────────────────────────────────────────────────────────────

let settings = null

function renderSettings() {
  $('#set-enabled').classList.toggle('on', settings.enabled)
  $('#set-clear-exit').classList.toggle('on', settings.clearOnExit)
  for (const b of document.querySelectorAll('#set-retention button')) {
    b.classList.toggle('selected', Number(b.dataset.value) === settings.retentionDays)
  }
}

async function updateSettings(partial) {
  settings = await send('/api/history/settings', 'PUT', partial)
  renderSettings()
}

$('#set-enabled').addEventListener('click', () => updateSettings({ enabled: !settings.enabled }))
$('#set-clear-exit').addEventListener('click', () => updateSettings({ clearOnExit: !settings.clearOnExit }))
$('#set-retention').addEventListener('click', async (e) => {
  const button = e.target.closest('button')
  if (!button) return
  await updateSettings({ retentionDays: Number(button.dataset.value) })
  load() // older items may have just been removed
})

// ── Clear browsing data ──────────────────────────────────────────────────

let range = 'hour'

function renderRange() {
  for (const b of document.querySelectorAll('#clear-range button')) b.classList.toggle('selected', b.dataset.value === range)
  $('#cookies-note').textContent =
    range === 'all' ? 'Signs you out of most sites' : 'For sites you visited in this time range'
}

$('#open-clear').addEventListener('click', () => {
  renderRange()
  $('#clear-dialog').showModal()
})
$('#clear-range').addEventListener('click', (e) => {
  const button = e.target.closest('button')
  if (!button) return
  range = button.dataset.value
  renderRange()
})
$('#clear-cancel').addEventListener('click', () => $('#clear-dialog').close())
$('#clear-confirm').addEventListener('click', async () => {
  const options = { range }
  for (const box of document.querySelectorAll('#clear-dialog input[type="checkbox"]')) options[box.name] = box.checked
  $('#clear-confirm').disabled = true
  try {
    await send('/api/history/clear', 'POST', options)
    toast('Browsing data cleared')
  } catch {
    toast('Couldn’t clear browsing data')
  } finally {
    $('#clear-confirm').disabled = false
    $('#clear-dialog').close()
    load()
  }
})

// ── Start ────────────────────────────────────────────────────────────────

json('/api/history/settings').then((s) => {
  settings = s
  renderSettings()
})
load()
