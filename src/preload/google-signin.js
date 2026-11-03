// On Google's sign-in pages only: finish presenting as Firefox (see src/main/google-signin.js) by
// removing the Chromium-only APIs that Firefox doesn't have, before the page's scripts run.
const { contextBridge } = require('electron')

if (location.hostname === 'accounts.google.com') {
  contextBridge.executeInMainWorld({
    func: () => {
      delete Navigator.prototype.userAgentData
      delete window.chrome
    },
  })
}
