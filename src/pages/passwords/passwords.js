'use strict'

const TOKEN = document.querySelector('meta[name="glasswing-token"]')?.content ?? ''
const send = (url, method) => fetch(url, { method, headers: { 'x-glasswing-token': TOKEN } })
const FAVICON_SERVICE =(host) => `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`

function hostOf(origin) {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

function card({ origin, subtitle, onRemove, label = 'Remove' }) {
  const el = document.createElement('div')
  el.className = 'card'

  const icon = document.createElement('img')
  icon.alt = ''
  icon.src = FAVICON_SERVICE(hostOf(origin))

  const info = document.createElement('div')
  const name = document.createElement('div')
  name.className = 'name'
  name.textContent = hostOf(origin)
  const desc = document.createElement('div')
  desc.className = 'desc'
  desc.textContent = subtitle
  info.append(name, desc)

  const remove = document.createElement('button')
  remove.className = 'danger'
  remove.textContent = label
  remove.addEventListener('click', async () => {
    remove.disabled = true
    await onRemove()
    load()
  })

  el.append(icon, info, remove)
  return el
}

async function load() {
  const { saved, never } = await fetch('/api/passwords').then((r) => r.json())

  const savedList = document.getElementById('saved')
  savedList.replaceChildren(
    ...saved.map((entry) =>
      card({
        origin: entry.origin,
        subtitle: entry.username || '(no username)',
        onRemove: () => send(`/api/passwords/${entry.id}`, 'DELETE'),
      }),
    ),
  )
  if (!saved.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'No saved passwords yet. Sign in to a site and choose “Save”.'
    savedList.append(empty)
  }

  document.getElementById('never-title').hidden = never.length === 0
  document.getElementById('never').replaceChildren(
    ...never.map((origin) =>
      card({
        origin,
        subtitle: 'Won’t offer to save passwords here',
        label: 'Allow',
        onRemove: () => send(`/api/passwords/never?origin=${encodeURIComponent(origin)}`, 'DELETE'),
      }),
    ),
  )
}

load()
