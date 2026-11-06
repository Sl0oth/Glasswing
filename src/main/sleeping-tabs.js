// Tabs left alone for a while give back their memory, and wake with a reload when they're selected.
//
// Normally that's after 30 minutes. While the browser is over its memory budget it's after 5, longest
// unused first, and only until it's back under. One tab at a time, because each one changes the total.
const { app } = require('electron')
const store = require('./store')

const SLEEP_AFTER_MS = 30 * 60_000
const SLEEP_OVER_BUDGET_AFTER_MS = 5 * 60_000
const MEMORY_BUDGET_BYTES = 800 * 1024 * 1024 // memory committed, which runs well above what Task Manager shows
const CHECK_EVERY_MS = 20_000

const enabled = () => store.get('sleepTabs') !== false

function setEnabled(on) {
  store.set('sleepTabs', Boolean(on))
  const { BrowserShell } = require('./shell')
  for (const shell of BrowserShell.all) shell.scheduleState()
}

function memoryInUse() {
  return app.getAppMetrics().reduce((sum, process) => sum + process.memory.privateBytes * 1024, 0)
}

async function check(now = Date.now()) {
  if (!enabled()) return
  const { BrowserShell } = require('./shell')
  const tabs = [...BrowserShell.all].flatMap((shell) => [...shell.tabs.values()])
  const each = (tab, after) => tab.sleepIfUnused(now, after).catch((err) => console.error('Could not put a tab to sleep:', err))
  await Promise.all(tabs.map((tab) => each(tab, SLEEP_AFTER_MS)))
  if (memoryInUse() <= MEMORY_BUDGET_BYTES) return
  for (const tab of tabs.sort((a, b) => a.lastSeen - b.lastSeen)) {
    if (await each(tab, SLEEP_OVER_BUDGET_AFTER_MS)) return
  }
}

function start() {
  setInterval(check, CHECK_EVERY_MS).unref?.()
}

module.exports = { SLEEP_AFTER_MS, SLEEP_OVER_BUDGET_AFTER_MS, MEMORY_BUDGET_BYTES, enabled, setEnabled, check, start }
