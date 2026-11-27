// In split view, a link clicked on the left side opens on the right, so the left can stay put as a list.
//
// This has to happen as the click happens, before the page acts on it, because many sites change pages
// by themselves and the browser would never hear about it. Anything that doesn't look like a plain link
// is left alone, so the worst this can get wrong is a link behaving the way it does in any other browser.
const { ipcRenderer } = require('electron')

const CONTROLS = 'button,input,select,textarea,label,summary,[role=button],[contenteditable]'
// Links in name only (they open menus or switch tabs), and ones that move through what's on this side.
const NOT_PLAIN_LINKS =
  '[role=button],[role=tab],[role=menuitem],[role=option],[role=switch],[role=checkbox],[role=radio],' +
  '[aria-haspopup],[aria-expanded],[aria-controls],[data-toggle],[data-bs-toggle],[rel~=next],[rel~=prev],[download]'
const SAME_WINDOW_TARGETS = ['', '_self', '_top', '_parent', '_blank']

/** The link that was clicked, looking inside the shadow DOM that a click's target hides. */
function clickedLink(event) {
  for (const node of event.composedPath()) {
    if (!(node instanceof Element)) continue
    if (node.matches('a[href],area[href]')) return node
    if (node.matches(CONTROLS)) return null
  }
  return null
}

function plainLink(event) {
  const link = clickedLink(event)
  if (!link || typeof link.href !== 'string' || link.matches(NOT_PLAIN_LINKS)) return null
  if (!SAME_WINDOW_TARGETS.includes(link.target.toLowerCase())) return null
  let url
  try {
    url = new URL(link.href)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const here = new URL(location.href)
  url.hash = ''
  here.hash = ''
  return url.href === here.href ? null : link // a jump within this page
}

if (window === window.top && /^https?:$/.test(location.protocol)) {
  // The browser says when this changes. It can't be asked during a click, because waiting for an answer here would
  // freeze the page for good if one never came. Until it says, a link just behaves like a link.
  let sendsLinksAcross = false
  ipcRenderer.on('split-links:state', (_event, on) => {
    sendsLinksAcross = on === true
  })

  window.addEventListener(
    'click',
    (event) => {
      // Our own click below isn't trusted, so it goes to the page like any other. Pages can't fake one either.
      if (!sendsLinksAcross || !event.isTrusted || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return
      const link = plainLink(event)
      if (!link) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.altKey) return link.click() // Alt: stay on this side
      ipcRenderer.invoke('split-links:open', link.href).then(
        (opened) => opened || link.click(),
        () => link.click(),
      )
    },
    true,
  )
}
