// On Google's sign-in pages only: what the page can read matches what its requests say (see
// src/main/google-signin.js), before the page's scripts run.
const { contextBridge } = require('electron')

// Worked out here, not asked of the main process: this has to be ready before the page's scripts run,
// and a blocking wait for an answer freezes the whole page for good if the answer never comes.
// The same as signInUserAgent() in src/main/google-signin.js; the smoke test checks that they match.
function signInUserAgent() {
  return navigator.userAgent.replace(/Chrome\/[\d.]+ Safari/, `Chrome/${process.versions.chrome} Electron/${process.versions.electron} Safari`)
}

if (location.hostname === 'accounts.google.com') {
  contextBridge.executeInMainWorld({
    func: (userAgent) => {
      const appVersion = userAgent.replace('Mozilla/', '')
      Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => userAgent, configurable: true })
      Object.defineProperty(Navigator.prototype, 'appVersion', { get: () => appVersion, configurable: true })
    },
    args: [signInUserAgent()],
  })
}
