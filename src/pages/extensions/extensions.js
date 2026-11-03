'use strict'

const list = document.getElementById('list')
const TOKEN = document.querySelector('meta[name="glasswing-token"]')?.content ?? ''
const send = (url, method) => fetch(url, { method, headers: { 'x-glasswing-token': TOKEN } })

async function load() {
  const extensions = await fetch('/api/extensions').then((r) => r.json())
  list.replaceChildren()

  if (!extensions.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'No extensions yet. Open the Chrome Web Store and click “Add to Chrome”.'
    list.append(empty)
    return
  }

  for (const ext of extensions) {
    const card = document.createElement('div')
    card.className = 'card'

    const icon = document.createElement('img')
    icon.src = `/api/extensions/${ext.id}/icon`
    icon.alt = ''
    icon.onerror = () => icon.replaceWith(Object.assign(document.createElement('div'), { className: 'placeholder' }))

    const info = document.createElement('div')
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = ext.name
    const version = document.createElement('span')
    version.className = 'version'
    version.textContent = ext.version
    name.append(version)
    const desc = document.createElement('div')
    desc.className = 'desc'
    desc.textContent = ext.description
    info.append(name, desc)

    const actions = document.createElement('div')
    actions.className = 'actions'
    if (ext.hasOptions) {
      const options = document.createElement('button')
      options.className = 'secondary'
      options.textContent = 'Options'
      options.addEventListener('click', () => send(`/api/extensions/${ext.id}/options`, 'POST'))
      actions.append(options)
    }
    const remove = document.createElement('button')
    remove.className = 'danger'
    remove.textContent = 'Remove'
    remove.addEventListener('click', async () => {
      remove.disabled = true
      await send(`/api/extensions/${ext.id}`, 'DELETE')
      load()
    })
    actions.append(remove)

    card.append(icon, info, actions)
    list.append(card)
  }
}

load()
