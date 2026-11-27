'use strict'

const $ = (id) => document.getElementById(id)
const TOKEN = document.querySelector('meta[name="glasswing-token"]')?.content ?? ''
const send = (url, method, body) =>
  fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-glasswing-token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json())

let data = null
let rulesEdited = false

function describeLists() {
  if (data.status === 'loading') return 'Downloading…'
  if (data.status === 'unavailable') return 'Couldn’t download them. Trying again soon.'
  if (!data.lastUpdated) return 'Built in for this session'
  const when = new Date(data.lastUpdated).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })
  return `Last updated ${when}. They update by themselves every week.`
}

function siteCard(site) {
  const card = document.createElement('div')
  card.className = 'card'
  const name = Object.assign(document.createElement('div'), { className: 'name', textContent: site })
  const remove = Object.assign(document.createElement('button'), { className: 'danger', textContent: 'Remove' })
  remove.addEventListener('click', async () => {
    remove.disabled = true
    data = await send(`/api/protection/allowed?site=${encodeURIComponent(site)}`, 'DELETE')
    render()
  })
  card.append(name, remove)
  return card
}

function render() {
  $('ads').classList.toggle('on', data.ads)
  $('trackers').classList.toggle('on', data.trackers)
  $('secureDns').classList.toggle('on', data.secureDns)
  $('total').textContent = data.blockedTotal
    ? `${data.blockedTotal.toLocaleString()} ads and trackers blocked so far`
    : 'Blocks ads and trackers on every site, except the ones you allow.'
  $('updated').textContent = describeLists()
  $('sites').replaceChildren(...data.allowedSites.map(siteCard))
  if (!data.allowedSites.length) {
    $('sites').append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'No sites allowed yet.' }))
  }
  if (!rulesEdited) $('rules').value = data.customRules
}

async function load() {
  data = await fetch('/api/protection').then((r) => r.json())
  render()
}

for (const key of ['ads', 'trackers', 'secureDns']) {
  $(key).addEventListener('click', async () => {
    data = await send('/api/protection', 'PUT', { [key]: !data[key] })
    render()
  })
}

$('add-site').addEventListener('submit', async (e) => {
  e.preventDefault()
  const site = $('site').value.trim()
  if (!site) return
  data = await send('/api/protection/allowed', 'POST', { site })
  if (data.error) {
    $('site').select()
    await load()
    return
  }
  $('site').value = ''
  render()
})

$('rules').addEventListener('input', () => {
  rulesEdited = true
  $('rules-saved').textContent = ''
})

$('save-rules').addEventListener('click', async () => {
  data = await send('/api/protection/rules', 'PUT', { rules: $('rules').value })
  rulesEdited = false
  render()
  $('rules-saved').textContent = 'Saved. Reload a page to see the difference.'
})

$('update').addEventListener('click', async () => {
  $('update').disabled = true
  $('updated').textContent = 'Updating…'
  data = await send('/api/protection/update', 'POST')
  $('update').disabled = false
  render()
})

load()
