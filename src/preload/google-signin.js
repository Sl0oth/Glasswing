// On Google's sign-in pages only: finish presenting as Firefox (see src/main/google-signin.js) by
// matching what the page can read to what its requests say, and removing the Chromium-only APIs that
// Firefox doesn't have, before the page's scripts run.
const { contextBridge, ipcRenderer } = require('electron')

if (location.hostname === 'accounts.google.com') {
  contextBridge.executeInMainWorld({
    func: (userAgent) => {
      delete Navigator.prototype.userAgentData
      delete window.chrome
      const appVersion = userAgent.replace('Mozilla/', '')
      Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => userAgent, configurable: true })
      Object.defineProperty(Navigator.prototype, 'appVersion', { get: () => appVersion, configurable: true })
    },
    args: [ipcRenderer.sendSync('google-signin:user-agent')],
  })
}
