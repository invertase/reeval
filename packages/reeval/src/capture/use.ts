// Vision journey on an open Chrome session: one string is a goal, `{ wait }` is a beat.
// The model sees an ephemeral full-page PNG and returns tools; handlers send Input.*.
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { debugLog, debugTrace } from '../debug/attempt.ts'
import { formatDuration, plural } from '../text.ts'
import type {
  CaptureInstruction,
  CaptureStep,
  CaptureUse,
  CaptureUseAction,
  CaptureUseMove,
  CaptureUseSpend,
  TokenUsage,
  Wait,
} from '../types.ts'
import { addUsage } from '../usage.ts'
import { CAPTURE_KEYS, type ChromeSession, navigateAndWait, type PageLayout } from './browser.ts'
import {
  describeChange,
  differing,
  LATE_INPUT_MS,
  lateSettledState,
  type PageState,
  pathOf,
  probePage,
  type StateField,
  settledState,
} from './page-state.ts'
import { pngSize } from './stub.ts'

/** Silent cap per instruction string, on the model's turns; not in the eval API. */
export const CAPTURE_USE_MOVE_CAP = 32

/**
 * The same move in a row that changes nothing: the model is nudged from the `NUDGE_AT`th and the
 * capture stops at the `STUCK_AT`th.
 */
export const CAPTURE_USE_NUDGE_AT = 2
export const CAPTURE_USE_STUCK_AT = 5

/** Points within this many CSS pixels of each other are the same move. */
const SAME_POINT = 8

/** Model turns in a row thrown away because the page changed while the model chose. */
const STALE_ASKS = 2

export type JourneyResult = {
  png: Buffer
  moves: number
  model: string | undefined
  usage: TokenUsage | null
}

export type JourneyOptions = {
  wait: Wait
  timeoutMs: number
  fullPage: boolean
  instructions: CaptureInstruction[]
  /**
   * Resolved driver: cascade/call `model`, call `fake`, or the fallback, `analysis.model` then
   * `judge.model`.
   */
  use?: CaptureUse
  remaining: () => number
  loadModel?: (name: string) => Promise<unknown>
  /** The capture's whole `timeout`, for the message when it runs out. Defaults to `timeoutMs`. */
  budgetMs?: number
  /** Each instruction's screenshot as it ends, stopped or not: returns where it was saved. */
  onStep?: (shot: StepShot) => string | undefined
}

/** One instruction's screenshot as it ended, and what it took. */
export type StepShot = Omit<CaptureStep, 'of'> & { png: Buffer }

/** How long a stopped instruction's screenshot may take once the budget is spent. */
const STOPPED_SHOT_MS = 5_000

/** Where a journey is, for the messages that stop it. */
type Step = { goal: string; index: number; total: number; moves: number }

/** A model-driven instruction's moves so far, for why it stalled. */
type Trail = { origin: string; start: PageState; made: Move[]; choosing: boolean }

/** The capture's budget, and what the journey is doing when it runs out. */
type Clock = {
  budgetMs: number
  remaining: () => number
  detail: string
  step?: Step
  trail?: Trail
}

function timedOut(clock: Clock): Error {
  const { step } = clock
  const where = step
    ? ` (instruction ${step.index} of ${step.total}, after ${plural(step.moves, 'move')})`
    : ''
  return new Error(
    `c.capture() timed out on ${clock.detail}${where}: it used all of its ${formatDuration(clock.budgetMs)} timeout${stallReason(clock)}. Raise timeout on the call or capture.timeout.`,
  )
}

/** Why the instruction's moves never finished it, as a clause; empty when nothing says. */
function stallReason({ step, trail }: Clock): string {
  if (!step || !trail) return ''
  const paths = [trail.start, ...trail.made.map((m) => m.after)].flatMap((s) =>
    s ? [pathOf(s.url, trail.origin) ?? s.url] : [],
  )
  for (let k = 2; k < paths.length; k++) {
    const path = paths[k]
    const first = paths.indexOf(path)
    if (first < k && paths.slice(first + 1, k).some((p) => p !== path)) {
      return `; its moves left ${path} and came back to it, so the model may be undoing what it did`
    }
  }
  if (trail.choosing) return `; the model was still choosing move ${step.moves + 1}`
  return ''
}

function check(clock: Clock): number {
  const left = clock.remaining()
  if (left <= 0) throw timedOut(clock)
  return left
}

/** `work()`, or the timeout once the budget runs out first: a page can hold any CDP call open. */
function race<T>(clock: Clock, work: () => Promise<T>): Promise<T> {
  const left = clock.remaining()
  if (left <= 0) return Promise.reject(timedOut(clock))
  let timer: ReturnType<typeof setTimeout> | undefined
  const out = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timedOut(clock)), left)
  })
  return Promise.race([work(), out]).finally(() => clearTimeout(timer))
}

/** `session` with every call raced against the clock, and its own waits' timeouts named as the budget's. */
function onClock(session: ChromeSession, clock: Clock): ChromeSession {
  const own = (error: unknown) => {
    throw /c\.capture\(\) timed out/.test(String(error)) ? timedOut(clock) : error
  }
  return {
    window: session.window,
    cdp: {
      on: (method, fn) => session.cdp.on(method, fn),
      send: (method, params) => race(clock, () => session.cdp.send(method, params)),
    },
    navigate: (url) => race(clock, () => session.navigate(url)),
    wait: (wait, ms, nav) => race(clock, () => session.wait(wait, ms, nav).catch(own)),
    screenshot: (fullPage, clip) => race(clock, () => session.screenshot(fullPage, clip)),
    dispatch: (action, page) => race(clock, () => session.dispatch(action, page)),
    layout: () => race(clock, () => session.layout()),
    busy: () => session.busy(),
    requests: () => session.requests(),
    dialogs: () => session.dialogs(),
    page: (origin) => session.page(origin),
  }
}

function asUsage(value: {
  inputTokens?: { total?: number } | number | null
  outputTokens?: { total?: number } | number | null
}): TokenUsage {
  const input =
    typeof value.inputTokens === 'number' ? value.inputTokens : (value.inputTokens?.total ?? 0)
  const output =
    typeof value.outputTokens === 'number' ? value.outputTokens : (value.outputTokens?.total ?? 0)
  return { input, output, cacheRead: 0, cacheWrite: 0, reasoning: null }
}

// A blank string is no number: `Number('')` is 0, which would click the page's top edge.
const finite = (value: unknown): number | undefined => {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN
  return Number.isFinite(n) ? n : undefined
}

/**
 * The point at `x`/`y`, or both packed into one as `"217,163"`, which models sometimes send. A
 * half missing from the packed form (`"217,"`) is read from its own field.
 */
function point(input: Record<string, unknown>, x: string, y: string): [number, number] | undefined {
  const packed = typeof input[x] === 'string' ? (input[x] as string).split(',') : []
  const px = packed.length === 2 ? (finite(packed[0]) ?? finite(input[x])) : finite(input[x])
  const py = packed.length === 2 ? (finite(packed[1]) ?? finite(input[y])) : finite(input[y])
  return px === undefined || py === undefined ? undefined : [px, py]
}

/**
 * The action a tool call asks for, or why it can't be made. Only a click or a key press can
 * complete its goal: offered on `type`, models mark the text as final, not the goal.
 */
export function actionFromTool(
  name: string,
  input: Record<string, unknown>,
): CaptureUseAction | { refused: string } {
  if (name === 'done') return { type: 'done' }
  const move = moveFromTool(name, input)
  if ('refused' in move || (move.type !== 'click' && move.type !== 'key')) return move
  const completes = input.completesGoal === true || input.completesGoal === 'true'
  return completes ? { ...move, final: true } : move
}

function moveFromTool(
  name: string,
  input: Record<string, unknown>,
): CaptureUseMove | { refused: string } {
  if (name === 'type') {
    if (typeof input.text !== 'string') return { refused: 'it had no text' }
    return { type: 'type', text: input.text, ...(input.replace === true ? { replace: true } : {}) }
  }
  if (name === 'key') {
    const key = CAPTURE_KEYS.find((k) => k === input.key)
    if (!key) return { refused: `the key is not one of ${CAPTURE_KEYS.join(', ')}` }
    return { type: 'key', key }
  }
  const at = point(input, 'x', 'y')
  if (!at) return { refused: 'it had no numeric x and y' }
  const [x, y] = at
  if (name === 'scroll') {
    const dy = finite(input.dy)
    return dy === undefined ? { refused: 'it had no numeric dy' } : { type: 'scroll', x, y, dy }
  }
  if (name === 'drag') {
    const to = point(input, 'toX', 'toY')
    if (!to) return { refused: 'it had no numeric toX and toY' }
    return { type: 'drag', x, y, toX: to[0], toY: to[1] }
  }
  if (name === 'hover') return { type: 'hover', x, y }
  return { type: 'click', x, y }
}

/**
 * Gemini models answer a point normalized to 0–1000 across the image they were shown, whatever
 * the prompt asks, so their journeys are prompted in that scale and their points scaled back.
 */
export const normalizesPoints = (model: string) =>
  model
    .slice(model.lastIndexOf('/') + 1)
    .toLowerCase()
    .startsWith('gemini-')

const NORMALIZED = 1000

/** Above this many window heights, the model sees the window rather than the whole page. */
export const TALL_PAGE = 2

/**
 * The most pixels and the longest edge of the screenshot a model sees. Anthropic's API scales a
 * larger image down and its models then answer in the smaller image's pixels, so reeval scales it
 * itself and maps the points back.
 */
export const SHOT_PIXELS = 1_150_000
export const SHOT_EDGE = 1568

/** The screenshot a model chooses a move on, and the part of the page it shows. */
export type ModelShot = {
  png: Buffer
  /** The image's size in pixels. */
  image: { width: number; height: number }
  /** The page's area it shows, in CSS pixels: the whole page, or the window on a tall page. */
  region: { y: number; width: number; height: number }
  /** The page's size in CSS pixels. */
  page: { width: number; height: number }
  /** The page is taller than the region, which is the window. */
  partial: boolean
}

/** The scale that keeps a `width`×`height` image within `SHOT_PIXELS` and `SHOT_EDGE`. */
export function shotScale(width: number, height: number): number {
  const fit = Math.min(
    1,
    Math.sqrt(SHOT_PIXELS / (width * height)),
    SHOT_EDGE / Math.max(width, height),
  )
  return Math.floor(fit * 1000) / 1000
}

/** What a model is shown of `layout`: the whole page, unless it is over `TALL_PAGE` windows tall. */
export function shotRegion(
  layout: PageLayout,
  window: { width: number; height: number },
): ModelShot['region'] & { partial: boolean } {
  const height = Math.max(layout.height, window.height)
  if (height <= TALL_PAGE * window.height) {
    return { y: 0, width: window.width, height, partial: false }
  }
  const y = Math.min(Math.max(0, layout.scrollY), height - window.height)
  return { y, width: window.width, height: window.height, partial: true }
}

async function modelShot(session: ChromeSession): Promise<ModelShot> {
  const layout = await session.layout()
  if (!layout) {
    const png = await session.screenshot(true)
    const size = pngSize(png)
    return { png, image: size, region: { y: 0, ...size }, page: size, partial: false }
  }
  const { partial, ...region } = shotRegion(layout, session.window)
  const scale = shotScale(region.width, region.height)
  const png = await session.screenshot(!partial, { x: 0, ...region, scale })
  const page = {
    width: Math.max(layout.width, session.window.width),
    height: Math.max(layout.height, session.window.height),
  }
  return { png, image: pngSize(png), region, page, partial }
}

/**
 * An action's points, from the model's screenshot to page CSS pixels: 0–1000 across the image
 * for a model that normalizes, the image's pixels for any other. A point off the image is refused.
 */
export function toPagePoints(
  action: CaptureUseAction,
  shot: Pick<ModelShot, 'image' | 'region'>,
  normalized: boolean,
): CaptureUseAction | { refused: string } {
  const { image, region } = shot
  const span = normalized ? { width: NORMALIZED, height: NORMALIZED } : image
  const off = (px: number, py: number) => px < 0 || py < 0 || px > span.width || py > span.height
  const x = (n: number) => Math.round((n * region.width) / span.width)
  const y = (n: number) => Math.round(region.y + (n * region.height) / span.height)
  const refuse = (px: number, py: number) => ({
    refused: `(${px}, ${py}) is outside the screenshot, which is ${normalized ? `0-${NORMALIZED} on both axes` : `${image.width}×${image.height}`}`,
  })
  switch (action.type) {
    case 'click':
    case 'hover':
    case 'scroll':
      if (off(action.x, action.y)) return refuse(action.x, action.y)
      return { ...action, x: x(action.x), y: y(action.y) }
    case 'drag':
      if (off(action.x, action.y)) return refuse(action.x, action.y)
      if (off(action.toX, action.toY)) return refuse(action.toX, action.toY)
      return { ...action, x: x(action.x), y: y(action.y), toX: x(action.toX), toY: y(action.toY) }
    default:
      return action
  }
}

export const systemPrompt = (normalized: boolean) =>
  `You drive a web page from screenshots. Call one tool. ${
    normalized
      ? `Coordinates are normalized to 0-${NORMALIZED} on the screenshot: x and toX across its width, y and toY down its height.`
      : 'Coordinates are pixels on the screenshot, whose size each turn gives.'
  } A scroll's dy is in page pixels, positive to scroll down. Each turn you get the goal, what has focus, your earlier moves with what each did, and a fresh screenshot. Click a field before typing into it, and do not repeat a move that already worked. A dropdown (select) never opens in the screenshot: click it once, press ArrowDown or ArrowUp until it shows the option you want, then press Enter to choose it. On a click or key press after which nothing of the goal is left, such as the click that submits a form you have filled in, set completesGoal to true: reeval makes it and goes on to the next goal without asking you again. A goal with more than one step (sign in and allow access, fill in and confirm) is complete only on its last step's move, not on a submit that leads to the next step. Call done when the goal is met. Do not mention CDP.`

const completesGoal = z
  .boolean()
  .optional()
  .describe('True only on the last move the goal needs: nothing of the goal is left after it.')

const useTools = {
  click: tool({
    description: 'Click at (x, y) on the screenshot.',
    inputSchema: z.object({ x: z.number(), y: z.number(), completesGoal }),
  }),
  type: tool({
    description:
      'Insert text into the focused field. Click the field first. Set replace to true to replace what the field already holds instead of adding to it.',
    inputSchema: z.object({ text: z.string(), replace: z.boolean().optional() }),
  }),
  key: tool({
    description:
      'Press a key in the focused element. In a dropdown (select), click it, press ArrowDown or ArrowUp to the option, then Enter to choose it. Space toggles a focused checkbox.',
    inputSchema: z.object({ key: z.enum(CAPTURE_KEYS), completesGoal }),
  }),
  scroll: tool({
    description:
      'Wheel-scroll by dy page pixels with the pointer at (x, y): the page, or the scrolling box under the point.',
    inputSchema: z.object({ x: z.number(), y: z.number(), dy: z.number() }),
  }),
  drag: tool({
    description: 'Drag from (x, y) to (toX, toY).',
    inputSchema: z.object({
      x: z.number(),
      y: z.number(),
      toX: z.number(),
      toY: z.number(),
    }),
  }),
  hover: tool({
    description: 'Move the pointer to (x, y).',
    inputSchema: z.object({ x: z.number(), y: z.number() }),
  }),
  done: tool({
    description: 'The goal is finished. Leave the loop.',
    inputSchema: z.object({}),
  }),
}

async function runFakeScript(
  session: ChromeSession,
  script: CaptureUseAction[],
  step: Step,
  clock: Clock,
  volatile: Set<StateField>,
): Promise<Ended> {
  const goal = step.goal
  let moves = 0
  for (const action of script) {
    clock.step = { ...step, moves }
    check(clock)
    if (action.type === 'done') return { moves, ended: 'done' }
    if (moves >= CAPTURE_USE_MOVE_CAP) throw unfinished(step, clock)
    const ephemeral = await session.screenshot(true)
    const page = pngSize(ephemeral)
    debugTrace('check', 'capture-use', { goal, action, page }, `capture use ${action.type}`)
    await session.dispatch(action, page)
    moves++
    const settled = await settledState(session, volatile, clock.remaining)
    if (action.final) {
      await lateSettledState(session, settled, volatile, clock.remaining)
      return { moves, ended: 'final' }
    }
  }
  clock.step = { ...step, moves }
  while (clock.remaining() > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, clock.remaining())))
  }
  throw timedOut(clock)
}

/** How an instruction that didn't stop the capture ended. */
type Ended = { moves: number; ended: 'final' | 'done' }

const unfinished = (step: Step, clock: Clock) =>
  new Error(
    `c.capture() instruction ${step.index} of ${step.total} ${JSON.stringify(step.goal)} did not finish in ${CAPTURE_USE_MOVE_CAP} moves${stallReason(clock)}`,
  )

/** One move the model asked for, and what it did once the page settled. */
type Move = {
  said: string
  /** Equal for the same move: same tool, same input, points on a `SAME_POINT` grid. */
  key: string
  /** Why the move wasn't made: its input didn't name an action, or it can't land. */
  refused?: string
  before?: PageState
  after?: PageState
  dialogs: string[]
  changed?: boolean
  effect?: string
  /** What the pointer landed on, as `button "Pay"`. */
  target?: string
  /** reeval scrolled the window to make the move, so the window's pixels say nothing of it. */
  scrolled?: boolean
  /** Marked final, but it sent nothing, opened no page and no dialog, so its goal went on. */
  unproven?: boolean
}

const grid = (n: number) => Math.round(n / SAME_POINT)

export function moveKey({ final: _, ...action }: CaptureUseMove): string {
  switch (action.type) {
    case 'click':
    case 'hover':
      return JSON.stringify([action.type, grid(action.x), grid(action.y)])
    case 'scroll':
      return JSON.stringify([action.type, grid(action.x), grid(action.y), action.dy])
    case 'drag':
      return JSON.stringify([
        action.type,
        grid(action.x),
        grid(action.y),
        grid(action.toX),
        grid(action.toY),
      ])
    default:
      return JSON.stringify(action)
  }
}

/** Sets what `move` did, from its page before and `after`. */
function settleMove(
  move: Move,
  after: PageState,
  origin: string,
  volatile: ReadonlySet<StateField>,
): void {
  move.after = after
  const ignored: ReadonlySet<StateField> = move.scrolled ? new Set([...volatile, 'view']) : volatile
  const fields = move.before ? differing(move.before, after, ignored) : []
  const notes = move.before ? describeChange(after, fields, origin) : []
  for (const dialog of move.dialogs) notes.push(`the page opened ${dialog}, which reeval accepted`)
  move.changed = fields.length > 0 || move.dialogs.length > 0
  move.effect = notes.length ? notes.join('; ') : 'nothing changed'
}

/** The same move made, unchanged, at the end of `moves`: a refused move ends the run. */
function stuckMoves(moves: readonly Move[]): number {
  const last = moves.at(-1)
  let n = 0
  for (let i = moves.length - 1; i >= 0; i--) {
    const move = moves[i]
    if (!move || move.refused || move.key !== last?.key || move.changed !== false) break
    n++
  }
  return n
}

/** What the model reads about the page now: where it is and what has focus. */
function stateLines(now: PageState, origin: string, volatile: ReadonlySet<StateField>): string[] {
  const lines: string[] = []
  const path = pathOf(now.url, origin)
  if (path) lines.push(`The page is at ${path}.`)
  if (now.focus === null) lines.push('Nothing is focused.')
  else if (now.focus) {
    lines.push(`Focused: ${now.focus}${now.value ? `, holding ${JSON.stringify(now.value)}` : ''}.`)
    if (now.focus.startsWith('select')) {
      lines.push(
        'A dropdown never opens in the screenshot: press ArrowDown or ArrowUp to the option, then Enter; it holds the new option only after Enter.',
      )
    }
  }
  if (volatile.has('text') || volatile.has('nodes') || volatile.has('view')) {
    lines.push('Parts of the page keep changing on their own, so the effects below leave them out.')
  }
  return lines
}

/** The goal, where the journey is, the page now, and the moves so far with what each did. */
export function goalPrompt(
  step: Pick<Step, 'goal' | 'index' | 'total'>,
  earlier: readonly string[],
  now: PageState,
  moves: readonly Move[],
  origin: string,
  volatile: ReadonlySet<StateField> = new Set(),
  view: { shot?: Omit<ModelShot, 'png'>; normalized?: boolean; later?: readonly string[] } = {},
): string {
  const lines = [`Goal: ${step.goal}`]
  const quoted = (goals: readonly string[]) => goals.map((g) => JSON.stringify(g)).join(', ')
  if (step.total > 1) {
    const done = earlier.length ? ` Already done: ${quoted(earlier)}.` : ''
    const later = view.later?.length
      ? ` Still to come, not part of this goal: ${quoted(view.later)}.`
      : ''
    lines.push(`This is instruction ${step.index} of ${step.total}.${done}${later}`)
  }
  const { shot } = view
  if (shot && !view.normalized) {
    lines.push(`The screenshot is ${shot.image.width}×${shot.image.height} pixels.`)
  }
  if (shot?.partial) {
    lines.push(
      `The page is ${shot.page.height} px tall, more than the screenshot shows: it shows the window, scrolled ${shot.region.y} px down. Scroll to see the rest.`,
    )
  }
  lines.push(...stateLines(now, origin, volatile))
  if (!moves.length) {
    lines.push('You have made no moves for this goal yet.')
    return lines.join('\n')
  }
  lines.push('Your moves for this goal so far, oldest first. The screenshot shows the page now.')
  moves.forEach((m, i) => {
    const effect = m.refused ? `not made: ${m.refused}` : (m.effect ?? '')
    lines.push(
      `${i + 1}. ${m.said}${m.target ? ` on ${m.target}` : ''}${effect ? ` → ${effect}` : ''}`,
    )
  })
  if (moves.at(-1)?.unproven) {
    lines.push(
      `Move ${moves.length} was marked completesGoal, but it sent no request and opened no page or dialog, so the goal goes on. If the goal is met, call done; if that move only opened a step on the way, such as a confirmation, finish it.`,
    )
  }
  if (stuckMoves(moves) >= CAPTURE_USE_NUDGE_AT) {
    lines.push(
      'Your last moves repeated the same action and nothing changed. Do not repeat it: if the goal is met, call done; otherwise try a different action.',
    )
  }
  const from = pathOf(moves.find((m) => m.before)?.before?.url, origin)
  const at = pathOf(now.url, origin)
  if (from && at && from !== at) {
    lines.push(
      `Your moves took the page from ${from} to ${at}. If they did what the goal asks, call done: a goal's "once", "if" or "when" says where it starts, so do not undo them to get back there.`,
    )
  }
  return lines.join('\n')
}

type Goal = {
  step: Step
  earlier: readonly string[]
  origin: string
  modelName: string
  clock: Clock
  volatile: Set<StateField>
  /** No move has been made yet in the journey. */
  pristine: boolean
  /** The instructions after this one. */
  later: readonly string[]
  loadModel: (name: string) => Promise<unknown>
}

async function runModelGoal(
  session: ChromeSession,
  { step, earlier, origin, modelName, clock, volatile, pristine, later, loadModel }: Goal,
): Promise<Ended & { usage: TokenUsage | null }> {
  const { goal } = step
  const model = await loadModel(modelName)
  const normalized = normalizesPoints(modelName)
  const made: Move[] = []
  let dispatched = 0
  let usage: TokenUsage | null = null
  // The journey's first look waits for the page to settle: content that loads after `load` lands
  // before the model chooses, not while it does.
  let now = pristine
    ? await settledState(session, volatile, clock.remaining)
    : await probePage(session)
  let stale = 0
  const trail: Trail = { origin, start: now, made, choosing: false }
  clock.trail = trail
  while (made.length < CAPTURE_USE_MOVE_CAP) {
    clock.step = { ...step, moves: dispatched }
    check(clock)
    const last = made.at(-1)
    if (last?.after) {
      // A change that lands after the move settled is still that move's, once it has settled too:
      // one read can catch it halfway, its text from before and its pixels from after.
      let late = await probePage(session)
      if (differing(last.after, late, volatile).length || session.busy()) {
        late = await settledState(session, volatile, clock.remaining)
      }
      last.dialogs.push(...session.dialogs())
      if (differing(last.after, late, volatile).length || last.dialogs.length) {
        settleMove(last, late, origin, volatile)
      }
      now = late
    }
    const stuck = stuckMoves(made)
    if (stuck >= CAPTURE_USE_STUCK_AT) {
      throw new Error(
        `c.capture() instruction ${step.index} of ${step.total} ${JSON.stringify(goal)} repeated ${last?.said}${last?.target ? ` on ${last.target}` : ''} ${CAPTURE_USE_STUCK_AT} times and nothing changed`,
      )
    }
    const shot = await modelShot(session)
    const { png: ephemeral, ...seen } = shot
    debugTrace(
      'check',
      'capture-shot',
      { goal, bytes: ephemeral.length, ...seen, url: now.url },
      false,
    )
    const signal = AbortSignal.timeout(check(clock))
    const asked = Date.now()
    trail.choosing = true
    const result = await race(clock, () =>
      generateText({
        model: model as never,
        system: systemPrompt(normalized),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: goalPrompt(step, earlier, now, made, origin, volatile, {
                  shot: seen,
                  normalized,
                  later,
                }),
              },
              { type: 'file', mediaType: 'image/png', data: ephemeral },
            ],
          },
        ],
        tools: useTools,
        toolChoice: 'required',
        stopWhen: stepCountIs(1),
        abortSignal: signal,
      }),
    ).catch((error: unknown) => {
      throw signal.aborted ? timedOut(clock) : error
    })
    trail.choosing = false
    usage = addUsage(usage, asUsage(result.usage ?? {}))
    const call = result.toolCalls?.[0]
    if (!call) {
      throw new Error(`c.capture() instruction ${JSON.stringify(goal)} returned no action`)
    }
    const input = (call.input ?? {}) as Record<string, unknown>
    const said = `${call.toolName} ${JSON.stringify(input)}`
    // The page changed while the model chose, so its move answers a page that's gone: a save
    // still landing invites a second submit. Credit the change and ask again, a bounded number of times.
    const fresh = await probePage(session)
    const opened = session.dialogs()
    const moved = differing(now, fresh, volatile)
    if ((moved.length || opened.length) && stale < STALE_ASKS) {
      // With no move yet in this instruction, the change is the last instruction's still landing,
      // or the page's own; `settledState` marks what keeps changing as volatile.
      stale++
      if (last && !last.refused) {
        last.dialogs.push(...opened)
        settleMove(last, fresh, origin, volatile)
      }
      now = fresh
      debugLog(
        'check',
        `capture use ${said} on ${JSON.stringify(goal)} not made: the page changed while the model chose`,
      )
      continue
    }
    stale = 0
    const tool = actionFromTool(call.toolName, input)
    let asks = 'refused' in tool ? tool : toPagePoints(tool, shot, normalized)
    if (!('refused' in asks) && asks.type === 'type' && now.editable === false) {
      asks = { refused: 'nothing that takes text is focused; click a field first' }
    }
    const logged =
      !('refused' in asks) && asks.type === 'type' && now.focus?.includes('[password]')
        ? `type ${JSON.stringify({ ...input, text: '•'.repeat(String(input.text ?? '').length) })}`
        : said
    const latency = formatDuration(Date.now() - asked)
    if ('refused' in asks) {
      debugLog(
        'check',
        `capture use ${logged} on ${JSON.stringify(goal)} not made: ${asks.refused} · ${latency}`,
      )
      made.push({ said, key: said, refused: asks.refused, dialogs: [] })
      continue
    }
    const page = shot.page
    debugLog('check', `capture use ${logged} on ${JSON.stringify(goal)} · ${latency}`)
    debugTrace('check', 'capture-use', { goal, action: asks, page }, `capture use ${asks.type}`)
    if (asks.type === 'done') return { moves: dispatched, usage, ended: 'done' }
    const move: Move = { said, key: moveKey(asks), before: now, dialogs: [] }
    made.push(move)
    const sent = session.requests()
    const landed = await session.dispatch(asks, page)
    if (landed?.target) move.target = landed.target
    if (landed?.scrolled) move.scrolled = true
    dispatched++
    now = await settledState(session, volatile, clock.remaining)
    // A hover menu or a debounced search answers a beat after the move: watch for it here, so
    // the model doesn't choose on the page before it.
    if (asks.type === 'type' || asks.type === 'hover') {
      now = await lateSettledState(session, now, volatile, clock.remaining, LATE_INPUT_MS)
    }
    move.dialogs.push(...session.dialogs())
    settleMove(move, now, origin, volatile)
    if (asks.final && move.changed) {
      // A move that sent nothing and stayed on the page may only have opened a step on the way
      // (a confirmation, a menu), or changed nothing but what reeval scrolled: the goal goes on.
      const left = now.url !== move.before?.url
      if (session.requests() > sent || left || move.dialogs.length) {
        await lateSettledState(session, now, volatile, clock.remaining)
        return { moves: dispatched, usage, ended: 'final' }
      }
      move.unproven = true
    }
  }
  clock.step = { ...step, moves: dispatched }
  throw unfinished(step, clock)
}

/** The page once an instruction stopped the capture, unless the screenshot takes too long. */
async function stoppedShot(raw: ChromeSession, fullPage: boolean): Promise<Buffer | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), STOPPED_SHOT_MS)
  })
  return Promise.race([raw.screenshot(fullPage).catch(() => undefined), late]).finally(() =>
    clearTimeout(timer),
  )
}

/**
 * Top-level wait, then the instruction loop, then the saved PNG.
 * Throws before `screenshot` when the budget or move cap is hit.
 */
export async function runJourney(
  raw: ChromeSession,
  url: string,
  options: JourneyOptions,
): Promise<JourneyResult> {
  const { wait, timeoutMs, fullPage, instructions, use, remaining } = options
  const clock: Clock = {
    budgetMs: options.budgetMs ?? timeoutMs,
    remaining,
    detail: wait === 'idle' ? 'loading the page with wait: "idle"' : 'loading the page',
  }
  const session = onClock(raw, clock)
  const origin = new URL(url).origin
  const volatile = new Set<StateField>()
  check(clock)
  await navigateAndWait(session, url, wait, Math.min(timeoutMs, remaining())).catch(
    (error: unknown) => {
      throw /c\.capture\(\) timed out/.test(String(error)) ? timedOut(clock) : error
    },
  )
  const goals = instructions.filter((s): s is string => typeof s === 'string')
  let moves = 0
  let usage: TokenUsage | null = null
  let stringIndex = 0
  for (const instruction of instructions) {
    if (typeof instruction !== 'string') {
      clock.detail = `{ wait: ${JSON.stringify(instruction.wait)} }`
      clock.step = undefined
      check(clock)
      await session.wait(instruction.wait, remaining(), undefined)
      continue
    }
    const step: Step = { goal: instruction, index: stringIndex + 1, total: goals.length, moves: 0 }
    clock.detail = JSON.stringify(instruction)
    clock.step = step
    check(clock)
    debugLog(
      'check',
      `capture instruction ${step.index} of ${step.total} ${JSON.stringify(instruction)}`,
    )
    const began = Date.now()
    const shot = (png: Buffer, ran: { moves: number; ended: CaptureStep['ended'] }) => {
      const ms = Date.now() - began
      debugLog(
        'check',
        `capture instruction ${step.index} of ${step.total} ${ran.ended} after ${plural(ran.moves, 'move')} in ${formatDuration(ms)}`,
      )
      return options.onStep?.({
        index: step.index,
        instruction,
        moves: ran.moves,
        ms,
        ended: ran.ended,
        png,
      })
    }
    try {
      let ran: Ended | undefined
      if (use && 'fake' in use) {
        ran = await runFakeScript(session, use.fake[stringIndex] ?? [], step, clock, volatile)
      } else if (use && 'model' in use) {
        if (!options.loadModel) {
          throw new Error('c.capture() instructions need a model loader')
        }
        const goal = await runModelGoal(session, {
          step,
          earlier: goals.slice(0, stringIndex),
          origin,
          modelName: use.model,
          clock,
          volatile,
          pristine: moves === 0,
          later: goals.slice(stringIndex + 1),
          loadModel: options.loadModel,
        })
        usage = addUsage(usage, goal.usage)
        ran = goal
      }
      if (ran) {
        moves += ran.moves
        clock.step = { ...step, moves: ran.moves }
        clock.trail = undefined
        shot(await session.screenshot(fullPage), ran)
      }
    } catch (error) {
      clock.trail = undefined
      const png = options.onStep && (await stoppedShot(raw, fullPage))
      const saved = png && shot(png, { moves: clock.step?.moves ?? 0, ended: 'stopped' })
      if (!saved || !(error instanceof Error)) throw error
      const sentence = error.message.endsWith('.') ? error.message : `${error.message}.`
      throw new Error(`${sentence} The page as it stopped: ${saved}.`)
    }
    stringIndex++
  }
  clock.detail = 'the final screenshot'
  clock.step = undefined
  check(clock)
  const png = await session.screenshot(fullPage)
  return {
    png,
    moves,
    model: use && 'model' in use ? use.model : use && 'fake' in use ? 'fake' : undefined,
    usage,
  }
}

export function captureUseSpend(result: JourneyResult): CaptureUseSpend | undefined {
  if (!result.model) return undefined
  return { model: result.model, moves: result.moves, usage: result.usage }
}
