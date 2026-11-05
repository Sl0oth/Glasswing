// Tabs left alone for a while give back their memory, and wake with a reload when they're selected.
const store = require('./store')

const SLEEP_AFTER_MS = 30 * 60_000
const CHECK_EVERY_MS = 60_000

const enabled = () => store.get('sleepTabs') !== false

function setEnabled(on) {
  store.set('sleepTabs', Boolean(on))
  const { BrowserShell } = require('./shell')
  for (const shell of BrowserShell.all) shell.scheduleState()
}

function check() {
  if (!enabled()) return
  const { BrowserShell } = require('./shell')
  const now = Date.now()
  for (const shell of BrowserShell.all) {
    for (const tab of shell.tabs.values()) {
      tab.sleepIfUnused(now).catch((err) => console.error('Could not put a tab to sleep:', err))
    }
  }
}

function start() {
  setInterval(check, CHECK_EVERY_MS).unref?.()
}

module.exports = { SLEEP_AFTER_MS, enabled, setEnabled, check, start }
