'use strict'

const root = document.documentElement.style
const card = document.getElementById('card')
const panes = { left: document.getElementById('pane-left'), right: document.getElementById('pane-right') }
const divider = document.getElementById('divider')

function place(el, r) {
  Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` })
}

// Split view: dragging in the gap between the two pages resizes them.
divider.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  e.preventDefault()
  let queued = null
  const onMove = (ev) => {
    if (ev.buttons === 0) return onUp()
    if (queued == null) {
      requestAnimationFrame(() => {
        window.backdrop.divider('drag', queued)
        queued = null
      })
    }
    queued = ev.clientX
  }
  const onUp = () => {
    document.body.classList.remove('resizing')
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  document.body.classList.add('resizing')
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
})
divider.addEventListener('dblclick', () => window.backdrop.divider('reset'))

window.backdrop.on((type, payload) => {
  if (type === 'appearance') {
    const [c1, c2] = payload.colors
    root.setProperty('--c1', c1)
    root.setProperty('--c2', c2)
    root.setProperty('--angle', `${payload.angle}deg`)
    root.setProperty('--tint', String(payload.tint))
    root.setProperty('--grain', String(payload.grain))
    root.setProperty('--accent', payload.accent)
    setTimeout(() => document.body.classList.add('ready'), 300)
  } else if (type === 'layout') {
    const { card: r, radius, split } = payload
    place(card, r)
    root.setProperty('--radius', `${radius}px`)
    document.body.classList.toggle('split', Boolean(split))
    if (split) {
      place(panes.left, split.left)
      place(panes.right, split.right)
      place(divider, split.divider)
      panes.left.classList.toggle('active', split.active === 'left')
      panes.right.classList.toggle('active', split.active === 'right')
    }
  }
})
