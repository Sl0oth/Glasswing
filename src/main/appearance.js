// User-customizable look: window tint, transparency, grain, corner radius, margins, accent.
const store = require('./store')

const PRESETS = [
  { id: 'graphite', name: 'Graphite', colors: ['#2c2c31', '#141416'] },
  { id: 'midnight', name: 'Midnight', colors: ['#232846', '#0c0d18'] },
  { id: 'ocean', name: 'Ocean', colors: ['#0f3a5c', '#081521'] },
  { id: 'aurora', name: 'Aurora', colors: ['#134e4a', '#2b1d52'] },
  { id: 'dusk', name: 'Dusk', colors: ['#3b2a6b', '#5a2342'] },
  { id: 'rose', name: 'Rose', colors: ['#5c1f3d', '#1c0c17'] },
  { id: 'ember', name: 'Ember', colors: ['#5a2a17', '#1d0f0a'] },
  { id: 'forest', name: 'Forest', colors: ['#1d4030', '#0a1712'] },
]

const ACCENTS = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff9f0a', '#30d158', '#64d2ff', '#e5e5ea']

const MATERIALS = ['acrylic', 'mica', 'none']

const DEFAULTS = {
  theme: 'midnight',
  colors: PRESETS[1].colors,
  angle: 135,
  tint: 0.6, // 0 = fully see-through glass, 1 = solid color
  grain: 0.12,
  radius: 12,
  gap: 8,
  accent: '#0a84ff',
  material: 'acrylic',
  autoHide: true, // toolbar hidden until the mouse touches the top edge; the page fills the window
  fullscreen: true, // windows open full screen (covers the taskbar)
  favoritesBar: true, // row of favorites under the toolbar
}

const HEX = /^#[0-9a-f]{6}$/i
const clamp = (v, min, max, fallback) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback)

function sanitize(input) {
  const a = { ...DEFAULTS, ...(input ?? {}) }
  return {
    theme: typeof a.theme === 'string' ? a.theme.slice(0, 32) : DEFAULTS.theme,
    colors:
      Array.isArray(a.colors) && a.colors.length === 2 && a.colors.every((c) => HEX.test(c))
        ? a.colors.map((c) => c.toLowerCase())
        : DEFAULTS.colors,
    angle: Math.round(clamp(a.angle, 0, 360, DEFAULTS.angle)),
    tint: clamp(a.tint, 0, 1, DEFAULTS.tint),
    grain: clamp(a.grain, 0, 0.5, DEFAULTS.grain),
    radius: Math.round(clamp(a.radius, 0, 24, DEFAULTS.radius)),
    gap: Math.round(clamp(a.gap, 0, 20, DEFAULTS.gap)),
    accent: HEX.test(a.accent) ? a.accent.toLowerCase() : DEFAULTS.accent,
    material: MATERIALS.includes(a.material) ? a.material : DEFAULTS.material,
    autoHide: typeof a.autoHide === 'boolean' ? a.autoHide : DEFAULTS.autoHide,
    fullscreen: typeof a.fullscreen === 'boolean' ? a.fullscreen : DEFAULTS.fullscreen,
    favoritesBar: typeof a.favoritesBar === 'boolean' ? a.favoritesBar : DEFAULTS.favoritesBar,
  }
}

function get() {
  return sanitize(store.get('appearance'))
}

function update(partial) {
  const next = sanitize({ ...get(), ...(partial ?? {}) })
  store.set('appearance', next)
  const { BrowserShell } = require('./shell')
  for (const shell of BrowserShell.all) shell.applyAppearance(next)
  return next
}

function reset() {
  return update(DEFAULTS)
}

module.exports = { get, update, reset, PRESETS, ACCENTS, MATERIALS, DEFAULTS }
