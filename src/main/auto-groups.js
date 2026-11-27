// Group tabs by site: with the switch on, two or more tabs from one site share a group named after it.
// Your own choices win. A tab you put in a group, or took out of one, is left where you put it, and a
// group you rename or recolor is yours and stays when the switch goes off.
const store = require('./store')

const STORE_KEY = 'autoGroups'
const MIN_TABS = 2

let parse = null
function siteOf(url) {
  let host
  try {
    const u = new URL(url)
    if (!/^https?:$/.test(u.protocol)) return null
    host = u.hostname
  } catch {
    return null
  }
  try {
    parse ??= require('tldts-experimental')
    return parse.getDomain(host, { allowPrivateDomains: true }) || host
  } catch {
    return host.replace(/^www\./, '')
  }
}

/** "youtube.com" → "YouTube"-ish: the name before the ending, capitalized. */
function nameFor(site) {
  const label = site.split('.')[0] || site
  return label.charAt(0).toUpperCase() + label.slice(1)
}

const enabled = () => store.get(STORE_KEY) === true

/** Puts each tab where its site says, leaving alone anything you arranged yourself. */
function arrange(shell) {
  if (!enabled() || shell.closed) return
  const tabs = shell.order.map((id) => shell.tabs.get(id)).filter(Boolean)
  // Tabs it may move: not placed by you, not in someone's own group, and not half of a split (those move as a pair).
  const movable = (tab) => {
    if (tab.groupedByHand || tab.split) return false
    const group = shell.groups.get(tab.groupId)
    return !group || group.auto
  }
  const bySite = new Map()
  for (const tab of tabs) {
    const site = siteOf(tab.url)
    if (!site) continue
    if (!bySite.has(site)) bySite.set(site, [])
    bySite.get(site).push(tab)
  }

  let changed = false
  const move = (tab, groupId) => {
    if (tab.groupId === groupId) return
    tab.groupId = groupId
    changed = true
  }

  for (const [site, siteTabs] of bySite) {
    const mine = siteTabs.filter(movable)
    const existing = [...shell.groups.values()].find((group) => group.site === site)
    // A group already there for the site takes its tabs; otherwise it takes enough of them to be worth one.
    const inGroup = existing ? siteTabs.filter((tab) => tab.groupId === existing.id).length : 0
    if (!existing && mine.length < MIN_TABS) continue
    if (existing && inGroup + mine.filter((tab) => tab.groupId !== existing.id).length < MIN_TABS) continue
    const group = existing ?? Object.assign(shell.addGroup({ name: nameFor(site) }), { auto: true, site })
    for (const tab of mine) move(tab, group.id)
  }

  // Tabs left in a site's group after going to another site come out, and a group down to one tab ends.
  for (const tab of tabs) {
    const group = shell.groups.get(tab.groupId)
    if (group?.auto && movable(tab) && siteOf(tab.url) !== group.site) move(tab, null)
  }
  for (const group of shell.groups.values()) {
    if (!group.auto) continue
    const members = tabs.filter((tab) => tab.groupId === group.id)
    if (members.length >= MIN_TABS) continue
    for (const tab of members) move(tab, null)
  }

  // The tab you're on can't hide inside a collapsed group.
  const active = shell.groups.get(shell.activeTab()?.groupId)
  if (active?.collapsed) {
    active.collapsed = false
    changed = true
  }
  if (!changed) return
  shell.keepTogether()
  shell.scheduleState()
}

/** Soon, and once, however many tabs changed at the same moment. */
function schedule(shell) {
  if (!enabled() || shell.autoGroupQueued) return
  shell.autoGroupQueued = true
  setTimeout(() => {
    shell.autoGroupQueued = false
    arrange(shell)
  }, 250)
}

/** Off ends the groups it made, apart from ones you've made your own. */
function setEnabled(on) {
  store.set(STORE_KEY, Boolean(on))
  const { BrowserShell } = require('./shell')
  for (const shell of BrowserShell.all) {
    if (on) {
      arrange(shell)
    } else {
      for (const group of [...shell.groups.values()]) if (group.auto) shell.ungroup(group.id, { byHand: false })
    }
    shell.scheduleState()
  }
}

module.exports = { enabled, setEnabled, arrange, schedule, siteOf, nameFor }
