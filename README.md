# Glasswing

A minimalist, dark, see-through browser. Safari-style compact tabs (the active tab *is* the
address bar), a toolbar that hides in Focus Mode / full screen, DuckDuckGo search, and Chrome
extensions installed straight from the Chrome Web Store.

## Run

```
npm install
npm start
```

## How it works

- **Electron 45 (Chromium)**: one window with the Windows 11 acrylic material (macOS vibrancy).
  Internal pages (new tab, extensions) are transparent, so the blurred desktop shows through.
- **Appearance** (palette button in the toolbar, or ⋯ → Customize Appearance):
  - Looks: theme presets or your own two-color gradient, angle, and tint strength (lower = more see-through).
  - Effects: grain, corner radius, and page margins.
  - Glass and accent: accent color and the glass type (Acrylic / Mica / None on Windows).
  - Settings save automatically and apply to all windows instantly.
  - Behind everything is the window's own page (`src/renderer/backdrop.*`), which paints the tint. The website floats above it as a rounded card.
- **Tabs** are `WebContentsView`s. The toolbar is a transparent view stacked on top. It grows to
  full height while a dropdown is open and shrinks to a 6px reveal strip in Focus Mode.
- **Chrome extensions**: `electron-chrome-extensions` implements the `chrome.*` APIs.
  `electron-chrome-web-store` makes "Add to Chrome" on chromewebstore.google.com install into
  Glasswing and keeps the installed extensions updated. The browser also reports a plain Chrome
  user agent.
- **Search**: DuckDuckGo for queries and suggestions. Favicons come from DuckDuckGo's icon service.

- **Layout**: opens full screen (covering the taskbar), with the toolbar hidden and the page edge to edge.
  Touch the top edge to reveal the toolbar. Turn off "Auto-hide toolbar" in Appearance to keep it visible.
- **Prompts and menus** (save password, site permissions, add extension, right-click, ⋯) are drawn
  by the browser in its own style. None of them are native OS dialogs.
- **Saved data**:
  - Cookies, localStorage and IndexedDB stay on disk and are flushed on quit.
  - Session cookies survive restarts, like Chrome's "continue where you left off". They're encrypted with the OS keystore.
- **Passwords**: offered for saving when you sign in, filled in automatically next time, and managed at ⋯ → Passwords.
  They're encrypted with the OS keystore (DPAPI on Windows).

## Shortcuts

| Action | Shortcut |
| --- | --- |
| New tab / window | Ctrl+T / Ctrl+N |
| Close tab / reopen closed | Ctrl+W / Ctrl+Shift+T |
| Search / address bar | Ctrl+K, Ctrl+L, Ctrl+E, Alt+D, F6 |
| History | Ctrl+H (or right-click **+** for the last 10 sites) |
| Find on page | Ctrl+F |
| Auto-hide toolbar on/off | Ctrl+Shift+F |
| Full screen | F11 |
| Add to favorites | Ctrl+D |
| Downloads | Ctrl+J |
| Zoom | Ctrl+= / Ctrl+- / Ctrl+0 |
| Switch tabs | Ctrl+Tab, Ctrl+1…9 |
| Developer tools | F12 |

## Notes

- Rename the browser in `src/main/constants.js` (`APP_NAME`).
- Some extension APIs are not implemented yet; see the electron-chrome-extensions README.
  Ad blockers (uBlock Origin Lite), password managers and Dark Reader work well.
- `npm audit` flags `adm-zip`, which electron-chrome-web-store uses to unpack extensions.
  It only unpacks packages downloaded from Google's Web Store.
