// Runs before every build. electron-builder's one-click installer shows its progress in the
// SpiderBanner plugin's own window, which can't be styled, so this removes that from its template.
// The installer's real page then shows instead, and build/installer.nsh styles that.
const fs = require('node:fs')
const path = require('node:path')

const file = path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'installSection.nsh')
const source = fs.readFileSync(file, 'utf8')
const banner = /\s*!ifdef HEADER_ICO\s+SpiderBanner::Show[\s\S]*?GetDlgItem \$0 \$0 1000\s+SendMessage \$0 \$\{WM_SETTEXT\} 0 "STR:\$\(installing\)"\r?\n/

if (!source.includes('SpiderBanner')) {
  console.log('Installer template already patched.')
} else if (banner.test(source)) {
  fs.writeFileSync(file, source.replace(banner, '\n'))
  console.log('Installer template patched.')
} else {
  // Better to stop than to quietly ship the unstyled installer.
  throw new Error('electron-builder\'s installSection.nsh has changed: update build/patch-installer.js')
}
