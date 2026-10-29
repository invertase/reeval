// What a journey can tell about the page between moves: the URL, the focused element and its
// value, the form controls, the text, and a viewport shot. A move's effect is the difference.
import type { ChromeSession } from './browser.ts'
import { pageChanged } from './png.ts'

/** The page between two moves. A field is missing when the page couldn't be read, mid-navigation. */
export type PageState = {
  url?: string
  /** The focused element, as `input[email] "Email"`, or null for none. */
  focus?: string | null
  /** The focused element's value: its text, `checked`, the chosen option, or a password's length. */
  value?: string | null
  /** Whether typing would land in the focused element. */
  editable?: boolean
  /** Hashes of every form control's state and of the page's text, and its element count. */
  form?: string
  text?: string
  nodes?: number
  view?: Buffer
}

export type StateField = 'url' | 'focus' | 'value' | 'form' | 'text' | 'nodes' | 'view'

const FIELDS: StateField[] = ['url', 'focus', 'value', 'form', 'text', 'nodes', 'view']

/** Page text in the prompt is capped: the page controls it. */
const TEXT_CAP = 60

// Read-only: it reads the DOM and returns plain data, and never dispatches an event.
const PROBE = `(() => {
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0).toString(36) }
  const clip = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim().slice(0, ${TEXT_CAP})
  let a = document.activeElement
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement
  if (a === document.body || a === document.documentElement) a = null
  const tag = a ? a.tagName.toLowerCase() : ''
  const type = a && tag === 'input' ? (a.type || 'text') : ''
  const label = a ? clip(a.getAttribute('aria-label') || (a.labels && a.labels[0] && a.labels[0].innerText) || a.getAttribute('placeholder') || a.getAttribute('name') || a.id || (tag === 'button' || tag === 'a' ? a.innerText : '')) : ''
  const toggles = type === 'checkbox' || type === 'radio'
  const value = !a ? null
    : toggles ? (a.checked ? 'checked' : 'unchecked')
    : tag === 'select' ? clip(a.selectedOptions && a.selectedOptions[0] ? a.selectedOptions[0].text : '')
    : type === 'password' ? a.value.length + ' characters'
    : tag === 'input' || tag === 'textarea' ? clip(a.value)
    : a.isContentEditable ? clip(a.innerText)
    : null
  const buttons = ['button', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden']
  const editable = !!a && ((tag === 'input' && !toggles && !buttons.includes(type)) || tag === 'textarea' || a.isContentEditable)
  const controls = Array.from(document.querySelectorAll('input,select,textarea'))
    .map((e) => (e.type === 'checkbox' || e.type === 'radio' ? (e.checked ? '1' : '0') : e.value))
  return {
    url: location.href,
    focus: a ? tag + (type ? '[' + type + ']' : '') + (label ? ' ' + JSON.stringify(label) : '') : null,
    value,
    editable,
    form: hash(controls.join('\\u0001')),
    text: hash(document.body ? document.body.innerText : ''),
    nodes: document.getElementsByTagName('*').length,
  }
})()`

/** Reads the page. A field it can't read is left out. */
export async function probePage(session: ChromeSession): Promise<PageState> {
  const read = (await session.cdp
    .send('Runtime.evaluate', { expression: PROBE, returnByValue: true })
    .catch(() => undefined)) as { result?: { value?: Omit<PageState, 'view'> } } | undefined
  const view = await session.screenshot(false).catch(() => undefined)
  return { ...(read?.result?.value ?? {}), ...(view ? { view } : {}) }
}

/** The fields that differ between two states, ignoring those `volatile` names. */
export function differing(
  before: PageState,
  after: PageState,
  volatile: ReadonlySet<StateField> = new Set(),
): StateField[] {
  return FIELDS.filter((field) => {
    if (volatile.has(field)) return false
    const a = before[field]
    const b = after[field]
    if (a === undefined || b === undefined) return a !== b
    if (field === 'view') return pageChanged(a as Buffer, b as Buffer)
    return a !== b
  })
}

/** The page's path, without its query or fragment, and capped. */
export function pathOf(url: string | undefined, origin: string): string | undefined {
  if (!url) return undefined
  const local = url.startsWith(`${origin}/`) ? url.slice(origin.length) : url
  const cut = local.search(/[?#]/)
  const path = cut === -1 ? local : `${local.slice(0, cut)}${local[cut] === '?' ? '?…' : ''}`
  return path.length > TEXT_CAP ? `${path.slice(0, TEXT_CAP)}…` : path
}

/** What changed between two states, in the words the model reads. */
export function describeChange(
  after: PageState,
  fields: readonly StateField[],
  origin: string,
): string[] {
  const notes: string[] = []
  const has = (f: StateField) => fields.includes(f)
  if (has('url'))
    notes.push(`now at ${pathOf(after.url, origin) ?? 'a page reeval could not read'}`)
  if (has('focus')) {
    notes.push(after.focus ? `focus moved to ${after.focus}` : 'nothing is focused now')
  }
  if (after.focus && (has('value') || (has('focus') && after.value))) {
    notes.push(`${after.focus} holds ${JSON.stringify(after.value ?? '')}`)
  } else if (has('form')) {
    notes.push('a form control changed')
  }
  if (has('text') || has('nodes')) notes.push("the page's content changed")
  else if (has('view') && !notes.length) notes.push('the page looks different')
  return notes
}

/** How often the settle loop reads the page, and the most it waits. */
export const SETTLE_POLL_MS = 100
export const SETTLE_CAP_MS = 3000

/**
 * Waits for the page to stop changing after a move: two reads `SETTLE_POLL_MS` apart that agree,
 * with no navigation or fresh request in flight. At `SETTLE_CAP_MS` it gives up and adds the
 * fields still changing to `volatile`, so a clock or an animation doesn't hold up every move.
 */
export async function settledState(
  session: ChromeSession,
  volatile: Set<StateField>,
  left: () => number,
): Promise<PageState> {
  const start = Date.now()
  const sleep = () =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(SETTLE_POLL_MS, left()))))
  let prev = await probePage(session)
  for (;;) {
    if (left() <= 0) return prev
    await sleep()
    const next = await probePage(session)
    const moving = differing(prev, next, volatile)
    if (!moving.length && !session.busy()) return next
    if (Date.now() - start >= SETTLE_CAP_MS || left() <= 0) {
      for (const field of moving) if (field !== 'url' && field !== 'focus') volatile.add(field)
      return next
    }
    prev = next
  }
}
