// Rename the browser here.
const APP_NAME = 'Glasswing'

module.exports = {
  APP_NAME,
  SCHEME: 'glasswing',
  NEWTAB_URL: 'glasswing://newtab/',
  EXTENSIONS_URL: 'glasswing://extensions/',
  PASSWORDS_URL: 'glasswing://passwords/',
  HISTORY_URL: 'glasswing://history/',
  SEARCH_URL: 'https://duckduckgo.com/?q=%s',
  SUGGEST_URL: 'https://duckduckgo.com/ac/?q=%s&type=list',
  FAVICON_URL: 'https://icons.duckduckgo.com/ip3/%s.ico',
  WEB_STORE_URL: 'https://chromewebstore.google.com/',

  // Chrome geometry (px). Must match --toolbar-height / --findbar-height in the UI CSS.
  TOOLBAR_HEIGHT: 46,
  FINDBAR_HEIGHT: 42,
  REVEAL_STRIP: 6,

  TRANSPARENT: '#00000000',
}
