// YouTube sometimes stops sending a video about 45 seconds in, and its player then says "Something went wrong.
// Refresh or try again later." Refreshing works. So this does that for you, at the same point in the video.
//
// It only acts on a video that was really playing, so a video that can't play at all ("Video unavailable", private,
// age-restricted) just shows its message. It's limited, because reloading in a loop is worse than an error: at
// most twice for a video in 10 minutes, and never over text you're typing. Then YouTube's own message stays up.
const MAX_TRIES = 2
const TRIES_LAST_MS = 10 * 60_000
const CHECK_EVERY_MS = 1000
const REMEMBERED = 'glasswing-youtube-recovery'

function triesFor(id, now) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(REMEMBERED) ?? '{}')
    return saved.id === id ? saved.at.filter((time) => now - time < TRIES_LAST_MS) : []
  } catch {
    return [] // not readable, or something else's data
  }
}

function typing() {
  const field = document.activeElement
  if (!field) return false
  if (field.isContentEditable) return Boolean(field.textContent.trim())
  return /^(TEXTAREA|INPUT)$/.test(field.tagName) && Boolean(field.value) && !field.matches('[role=combobox],[type=search],[name=search_query]')
}

let playedId = null
let playedTo = 0

function check() {
  if (location.pathname !== '/watch') return
  const url = new URL(location.href)
  const id = url.searchParams.get('v')
  const video = document.querySelector('video.html5-main-video')
  if (video?.currentTime > 0) {
    playedId = id
    playedTo = video.currentTime
  }
  if (playedId !== id || playedTo < 1 || (video && !video.paused)) return
  const message = document.querySelector('.ytp-error-content-wrap-reason') // innerText is empty unless it's showing
  if (!message?.innerText.trim() || typing()) return

  const now = Date.now()
  const tries = triesFor(id, now)
  if (tries.length >= MAX_TRIES) return
  try {
    sessionStorage.setItem(REMEMBERED, JSON.stringify({ id, at: [...tries, now] }))
  } catch {
    return // it couldn't remember trying, and so couldn't stop
  }
  url.searchParams.set('t', `${Math.floor(playedTo)}s`)
  location.replace(url.href)
}

if (window === window.top && /(^|\.)youtube\.com$/.test(location.hostname)) setInterval(check, CHECK_EVERY_MS)
