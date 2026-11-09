// A page is waiting for a code from your email (src/preload/email-code.js noticed), so this offers to open your mail
// next to it. Which email you use is only ever saved in this computer's profile, and it's asked for the first time it's needed.
const store = require('./store')
const prompts = require('./prompts')

const ASK_AGAIN_AFTER_MS = 10 * 60 * 1000
const SERVICES = [
  { name: 'Gmail', url: 'https://mail.google.com/', hosts: ['mail.google.com'] },
  { name: 'Outlook', url: 'https://outlook.live.com/mail/', hosts: ['outlook.live.com', 'outlook.office.com', 'outlook.office365.com'] },
  { name: 'Yahoo', url: 'https://mail.yahoo.com/', hosts: ['mail.yahoo.com'] },
  { name: 'iCloud', url: 'https://www.icloud.com/mail/', hosts: ['www.icloud.com'] },
  { name: 'Proton', url: 'https://mail.proton.me/', hosts: ['mail.proton.me'] },
]
const ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" fill="none" stroke="#a0a0a8" stroke-width="1.6" stroke-linejoin="round"><rect x="9" y="11.5" width="18" height="13" rx="2.5"/><path d="M10 13.5l8 6 8-6"/></svg>')}`

const asked = new Map() // site → when, in memory only, so saying no holds for a while and a reloading page doesn't ask twice

const enabled = () => store.get('emailCodes') !== false

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function savedService() {
  const saved = store.get('mailService')
  return typeof saved?.url === 'string' && /^https?:\/\//i.test(saved.url) && saved.name ? saved : null
}

const hostsOf = (service) => SERVICES.find((known) => known.url === service.url)?.hosts ?? [hostOf(service.url)]

const isMailPage = (tab, hosts) => hosts.includes(hostOf(tab.url))

/** Turns what someone typed into a web address for their email, or null if it can't be one. */
function customService(text) {
  const typed = String(text ?? '').trim()
  if (!typed) return null
  try {
    const url = new URL(/^https?:\/\//i.test(typed) ? typed : `https://${typed}`)
    if (!url.hostname.includes('.')) return null
    url.username = ''
    url.password = ''
    return { name: url.hostname.replace(/^www\./, ''), url: url.href }
  } catch {
    return null
  }
}

async function askForAddress(shell, tag) {
  let detail = 'The address you go to for your email, like mail.example.com. It’s only saved on this computer.'
  for (;;) {
    const { button, values } = await prompts.ask(shell, {
      tag,
      title: 'Where’s your email?',
      detail,
      icon: ICON,
      fields: [{ id: 'address', label: 'Web address' }],
      buttons: [
        { id: 'cancel', label: 'Cancel', style: 'secondary' },
        { id: 'open', label: 'Open', style: 'primary' },
      ],
      cancelId: 'cancel',
    })
    if (button !== 'open') return null
    const service = customService(values.address)
    if (service) return service
    detail = 'That doesn’t look like a web address. Try something like mail.example.com.'
  }
}

async function askWhichService(shell, tag) {
  const { button } = await prompts.ask(shell, {
    tag,
    title: 'Get your code from your email?',
    message: 'Pick your email and it opens next to this page.',
    detail: 'Your choice is only saved on this computer.',
    icon: ICON,
    buttons: [
      ...SERVICES.map(({ name }) => ({ id: name, label: name, style: 'secondary' })),
      { id: 'other', label: 'Other…', style: 'secondary' },
      { id: 'cancel', label: 'Not now', style: 'secondary' },
    ],
    cancelId: 'cancel',
  })
  if (button === 'cancel') return null
  if (button === 'other') return askForAddress(shell, tag)
  const { name, url } = SERVICES.find((known) => known.name === button)
  return { name, url }
}

/** Your email if you're happy with the one that's saved, or the one you pick instead. */
async function chooseService(shell, tag) {
  const saved = savedService()
  if (!saved) return askWhichService(shell, tag)
  const { button } = await prompts.ask(shell, {
    tag,
    title: `Open ${saved.name}?`,
    message: 'This page wants a code from your email.',
    icon: ICON,
    buttons: [
      { id: 'cancel', label: 'Not now', style: 'secondary' },
      { id: 'change', label: 'Change', style: 'secondary' },
      { id: 'open', label: `Open ${saved.name}`, style: 'primary' },
    ],
    cancelId: 'cancel',
  })
  if (button === 'open') return saved
  return button === 'change' ? askWhichService(shell, tag) : null
}

/** Shows your email beside the page, using a tab it's already open in. The page keeps the keyboard, ready for the code. */
function openBeside(tab, service) {
  const { shell } = tab
  if (shell.closed || !shell.tabs.has(tab.id) || tab.webContents.isDestroyed()) return
  const hosts = hostsOf(service)
  const open = shell.order.map((id) => shell.tabs.get(id)).find((other) => other !== tab && isMailPage(other, hosts))
  const mail = open ?? shell.createTab({ url: service.url, active: false, openerId: tab.id })
  shell.splitWith(tab.id, mail.id, 'left')
  tab.webContents.focus()
  if (mail.webContents.isLoading()) tab.keepFocusFrom(mail)
}

async function offer(tab) {
  const { shell } = tab
  const wc = tab.webContents
  if (!enabled() || shell.private || wc.isDestroyed() || !shell.visibleTabs().includes(tab)) return
  let site
  try {
    site = new URL(tab.url).origin
  } catch {
    return
  }

  // Your email is already where you can see it.
  const saved = savedService()
  const mailHosts = [...SERVICES.flatMap((known) => known.hosts), ...(saved ? hostsOf(saved) : [])]
  const partner = shell.partnerOf(tab)
  if (isMailPage(tab, mailHosts) || (partner && isMailPage(partner, mailHosts))) return

  const now = Date.now()
  if (now - (asked.get(site) ?? -Infinity) < ASK_AGAIN_AFTER_MS) return
  asked.set(site, now)

  const tag = `email-code-${tab.id}`
  const noLongerNeeded = () => prompts.closeTagged(tag)
  wc.once('did-navigate', noLongerNeeded)
  wc.once('destroyed', noLongerNeeded)
  const service = await chooseService(shell, tag)
  if (!wc.isDestroyed()) {
    wc.off('did-navigate', noLongerNeeded)
    wc.off('destroyed', noLongerNeeded)
  }
  if (!service) return
  store.set('mailService', service)
  openBeside(tab, service)
}

module.exports = { offer, enabled, forgetAsked: () => asked.clear() }
