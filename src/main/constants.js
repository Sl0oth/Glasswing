// Rename the browser here.
const APP_NAME = 'Glasswing'
const APP_ID = 'com.sl0oth.glasswing' // also "appId" in package.json

module.exports = {
  APP_ID,
  APP_NAME,
  SCHEME: 'glasswing',
  NEWTAB_URL: 'glasswing://newtab/',
  EXTENSIONS_URL: 'glasswing://extensions/',
  PASSWORDS_URL: 'glasswing://passwords/',
  HISTORY_URL: 'glasswing://history/',
  PROTECTION_URL: 'glasswing://protection/',
  FAVICON_URL: 'https://icons.duckduckgo.com/ip3/%s.ico',
  WEB_STORE_URL: 'https://chromewebstore.google.com/',

  // Chrome geometry (px). Must match --toolbar-height / --favbar-height / --findbar-height in the UI CSS.
  TOOLBAR_HEIGHT: 48,
  FAVBAR_HEIGHT: 36,
  FINDBAR_HEIGHT: 42,
  SHADOW_ROOM: 16, // extra height so the floating elements' shadows aren't cut off
  LOADING_STRIP: 3, // height of the UI view while it only shows the page-loading line

  // Opening a window.
  SHOW_PAGE_WAIT_MS: 500, // how long a new window waits for its page, once its own layers are ready
  SHOW_TIMEOUT_MS: 2000, // shows the window regardless after this long

  // Split view.
  SPLIT_GAP: 8, // space between the two pages; also what you grab to resize them
  SPLIT_MARGIN: 4, // space around them when the toolbar is auto-hidden, so the focus outline shows
  SPLIT_MIN_RATIO: 0.2,

  // Auto-hide timing and hit zones.
  REVEAL_ZONE: 5, // px from the top edge that brings the toolbar down
  REVEAL_ZONE_MAXIMIZED: 10, // maximized windows extend slightly past the top of the screen
  POINTER_POLL_MS: 50,
  CONCEAL_DELAY_MS: 450, // how long the pointer can stray before the toolbar slides away
  CONCEAL_ANIMATION_MS: 200, // must cover the slide-out transition in the UI CSS
  PEEK_MS: 1400, // brief reveal after switching tabs or changing a favorite

  TRANSPARENT: '#00000000',
}
