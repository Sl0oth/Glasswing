// Clean Up Tabs, in the ⋯ menu: offers to close the tabs you've clearly finished with. It only ever offers, and you can
// untick any of them. A tab you put in a group, or one with something going on in it, is never on the list.
const prompts = require('./prompts')
const { isNewTab } = require('./url')

const BRIEF_MS = 15_000 // on screen for no longer than this, all told
const BRIEF_UNUSED_MS = 15 * 60_000 // and not been back for this long
const OLD_MS = 3 * 24 * 60 * 60_000 // or not been used for this long, however long you once spent in it
const ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" fill="none" stroke="#a0a0a8" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 10.5l-8 8a2.2 2.2 0 0 0 0 3.1l1 1a2.2 2.2 0 0 0 3.1 0l8-8zM17 25.5h9"/></svg>')}`

function ago(ms) {
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return plural(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 48) return plural(hours, 'hour')
  return plural(Math.round(hours / 24), 'day')
}

/** Why a tab looks finished with, or null if it doesn't. */
function reasonToClose(tab, now) {
  if (isNewTab(tab.url)) return 'Empty new tab'
  const unused = now - tab.lastSeen
  if (unused >= OLD_MS) return `Last used ${ago(unused)}`
  // A tab you've never looked at may be one you opened to read later, so being brief takes having looked.
  const seen = tab.totalSeenMs(now)
  if (seen > 0 && seen <= BRIEF_MS && unused >= BRIEF_UNUSED_MS) return `Open for ${Math.max(1, Math.round(seen / 1000))} seconds, ${ago(unused)}`
  return null
}

async function findTabs(shell, now = Date.now()) {
  const onScreen = shell.visibleTabs()
  const possible = shell.order
    .map((id) => shell.tabs.get(id))
    .filter((tab) => !onScreen.includes(tab) && tab.groupId == null && !tab.webContents.isDestroyed() && !tab.webContents.isDevToolsOpened())
    .map((tab) => ({ tab, reason: reasonToClose(tab, now) }))
    .filter(({ reason }) => reason)
  const inUse = await Promise.all(possible.map(({ tab }) => tab.inUse()))
  return possible.filter((_, i) => !inUse[i]).sort((a, b) => a.tab.lastSeen - b.tab.lastSeen)
}

async function run(shell) {
  const found = await findTabs(shell)
  if (!found.length) {
    shell.sendEvent('flash', 'No tabs to clean up')
    shell.peek()
    return 0
  }
  const { button, values } = await prompts.ask(shell, {
    title: 'Clean up tabs?',
    message: 'Untick any you want to keep.',
    icon: ICON,
    checklist: found.map(({ tab, reason }) => ({ id: tab.id, label: isNewTab(tab.url) ? 'New Tab' : tab.title, sub: reason })),
    buttons: [
      { id: 'cancel', label: 'Cancel', style: 'secondary' },
      { id: 'close', label: 'Close Tabs', style: 'primary' },
    ],
    cancelId: 'cancel',
  })
  if (button !== 'close') return 0
  // It's had a while to change: only what's still out of sight gets closed.
  const onScreen = shell.visibleTabs().map((tab) => tab.id)
  const closing = found.map(({ tab }) => tab.id).filter((id) => values.picked?.includes(id) && shell.tabs.has(id) && !onScreen.includes(id))
  for (const id of closing) shell.closeTab(id)
  if (closing.length && !shell.closed) {
    shell.sendEvent('flash', `Closed ${closing.length} tab${closing.length === 1 ? '' : 's'}. Ctrl+Shift+T brings them back`)
    shell.peek()
  }
  return closing.length
}

module.exports = { run, findTabs, BRIEF_MS, BRIEF_UNUSED_MS, OLD_MS }
