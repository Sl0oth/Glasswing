# Glasswing

A minimalist, dark, see-through browser. There's no bar across the top: the toolbar's elements
float over the page and slide down when you touch the top edge. Safari-style compact tabs (the
active tab *is* the address bar), a favorites bar, your choice of search engine, built-in ad and
tracker blocking, and Chrome extensions installed straight from the Chrome Web Store.

## Download

Get `Glasswing-Setup.exe` from the [latest release](https://github.com/Sl0oth/Glasswing/releases/latest)
and run it. It installs for your Windows account, with no administrator password, then opens a short
setup: import from Chrome, Brave or Edge, choose a look and how you browse, and choose how updates work.

The installer isn't signed yet, so Windows SmartScreen may say it doesn't recognize it. Choose
**More info**, then **Run anyway**.

## Run from source

```
npm install
npm start
```

## Test

```
npm test
```

Drives the real browser against a local test site, in a throwaway profile, with no network needed.
Its windows are never shown and it doesn't use the GPU, so it's safe to run during a game.
`npm test -- --window-states` shows the window and also covers maximize and full screen, which do take
over the screen. Add `--shots=folder` to that to save pictures of each state.

`npx electron test/first-run.js` tests the setup window and importing, against fake browser profiles it
builds itself, also hidden. Add `--shots=folder` to see each step, which shows the window.

## Release

1. Set the new `version` in `package.json`.
2. `npm run dist` builds `dist/Glasswing-Setup.exe` and `dist/latest.yml`.
3. Publish a GitHub release tagged `v` plus the version, with both files attached:
   `gh release create v1.2.3 dist/Glasswing-Setup.exe dist/latest.yml`

Installed copies find it by themselves. They read the releases without signing in, so **this only works
while the repository is public**. With a private repository they can't see it, and checking for updates
just says it couldn't reach the server.

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
  full height while a dropdown is open. When auto-hidden it has no height at all (3px while a page
  loads, for the progress line), and the main process watches the pointer, so nothing sits over the page.
- **Floating elements**: one web view can't blur another, so the elements are a mostly solid dark
  glass instead of a blur. That keeps them readable over any page, light or dark.
- **Favorites bar**: under the toolbar, and left out on the new tab page, which shows the same list.
  - Star in the address bar or Ctrl+D to add or remove the current page.
  - Click to open, Ctrl+click or middle-click for a new tab, drag to reorder, right-click to edit or remove.
  - Favorites that don't fit go behind the » button. They also show up in address bar suggestions.
  - Turn the bar off with Ctrl+Shift+B, in the ⋯ panel, or in Appearance.
- **Chrome extensions**: `electron-chrome-extensions` implements the `chrome.*` APIs.
  `electron-chrome-web-store` makes "Add to Chrome" on chromewebstore.google.com install into
  Glasswing and keeps the installed extensions updated. The browser also reports a plain Chrome
  user agent.
- **Search**: DuckDuckGo, Google, Bing or Brave Search, for queries and suggestions (`src/main/search.js`).
  Favicons come from DuckDuckGo's icon service.
- **Setup window** (`src/main/setup.js`): opens once on first launch, before any browser window, and from
  ⋯ → Setup and Import after that. Choices apply as they're made, so closing it part way keeps them.
- **Importing** (`src/main/browser-import.js`): bookmarks, history, search engine and favorites bar setting
  from any profile of Chrome, Brave or Edge, even while that browser is open. Those browsers' files are
  only read. Up to 100 bookmarks become favorites, and the rest come up as you type in the address bar.
  Passwords, cookies and extensions aren't imported.
- **Updates** (`src/main/updater.js`): looks for a new release on launch and every 4 hours. By default it
  downloads quietly and asks before restarting, or it can ask before downloading. An update you put off
  installs when you quit. ⋯ → Check for Updates checks right away.
- **Camera, microphone and sound icons**: a tab that's using the camera or mic shows a red icon, on its tab
  or in the address field if it's the active one, and the toolbar slides down when it starts. A speaker
  shows on a tab playing sound, and clicking it mutes the tab. Starting can't be hidden, since every request goes
  through `src/main/permissions.js`. The page itself reports stopping (`src/preload/capture.js`), which only
  works for the top of the page: if a frame embedded in the page is recording, the icon stays until you leave that page.

- **Layout**: by default opens full screen (covering the taskbar), with the toolbar hidden and the page edge to edge.
  Touch the top edge to bring the elements down; they leave again once the pointer moves off them.
  They also stay on the new tab page, while editing the address, and while Find is open.
  Turn off "Auto-hide toolbar" in Appearance to keep them visible, with the page below them on the tint.
- **Moving tabs**: pull a tab down out of the tab strip and the page offers **Split left**, **New window**
  and **Split right**. Past the edge of the window also makes a new window. Drop a tab on another Glasswing
  window to move it there. The page moves with it and doesn't reload. A window closes when its last tab leaves.
- **Split view**: two tabs side by side. The tab you're on stays, and the one you dragged joins it.
  - Also from Ctrl+\, the ⋯ panel, or by right-clicking a tab.
  - Click a side to focus it, and drag the gap between them to resize. Double-click the gap to even it out.
  - The two show as joined in the tab strip, and split views are restored after a restart.
- **Ad and tracker blocking**: built in and on by default, using EasyList, EasyPrivacy and similar lists.
  - The shield button shows how much was blocked on the page, with a switch each for ads and trackers, and one
    to turn blocking off for just this site if it breaks something.
  - Ctrl+Shift+A or the ⋯ panel turns everything on or off. Changing a switch reloads the page.
  - The shield's Allowed Sites and Rules page manages the whitelist and your own rules, and can update the lists.
  - Sign-in, payment and CAPTCHA services are never blocked (`SAFEGUARDED_HOSTS` in `src/main/blocker.js`).
  - Lists download once in the background, are saved in the profile folder, and refresh weekly.
  - Video ads on some sites, YouTube especially, may still get through.
  - When ads are blocked, YouTube makes some signed-in accounts wait about 5 seconds before a video starts. One
    script in the lists tries to dodge this by reloading the player, which can loop forever, so it's left out
    (`reloadsYouTubePlayer` in `src/main/blocker.js`). Turning blocking off for YouTube removes the wait.
- **Private windows**: Ctrl+Shift+N, the ⋯ panel, or right-click a link. The toolbar turns purple and says Private.
  - Pages, cookies, logins and site data stay in memory and are gone once the last private window closes.
  - Nothing goes into history or the saved session, and typing isn't sent to the search engine for suggestions.
  - Passwords aren't filled in or saved, site permissions aren't remembered, and extensions are off. Blocking still works.
  - Downloaded files and favorites you add stay. Websites and your network can still see what you do.
  - A tab can't be dragged between a private window and a normal one.
- **Problems**: errors are written to `glasswing.log` in the profile folder rather than shown as
  dialogs. A page that crashes offers a Reload card, and a background tab reloads when you select it.
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
| New private window | Ctrl+Shift+N |
| Close tab / reopen closed | Ctrl+W / Ctrl+Shift+T |
| Search / address bar | Ctrl+K, Ctrl+L, Ctrl+E, Alt+D, F6 |
| History | Ctrl+H (or right-click **+** for the last 10 sites) |
| Find on page | Ctrl+F |
| Auto-hide toolbar on/off | Ctrl+Shift+F |
| Full screen | F11 |
| Split view on/off | Ctrl+\ |
| Ad and tracker blocking on/off | Ctrl+Shift+A |
| Add or remove favorite | Ctrl+D |
| Favorites bar on/off | Ctrl+Shift+B |
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
