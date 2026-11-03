'use strict'

const root = document.documentElement.style
const card = document.getElementById('card')

window.backdrop.on((type, payload) => {
  if (type === 'appearance') {
    const [c1, c2] = payload.colors
    root.setProperty('--c1', c1)
    root.setProperty('--c2', c2)
    root.setProperty('--angle', `${payload.angle}deg`)
    root.setProperty('--tint', String(payload.tint))
    root.setProperty('--grain', String(payload.grain))
  } else if (type === 'layout') {
    const { card: r, radius } = payload
    Object.assign(card.style, {
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    })
    root.setProperty('--radius', `${radius}px`)
  }
})
