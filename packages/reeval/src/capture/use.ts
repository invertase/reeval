// Vision journey on an open Chrome session: one string is a goal, `{ wait }` is a beat.
// The model sees an ephemeral full-page PNG and returns tools; handlers send Input.*.
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { debugLog, debugTrace } from '../debug/attempt.ts'
import { formatDuration, plural } from '../text.ts'
import type {
  CaptureInstruction,
  CaptureUse,
  CaptureUseAction,
  CaptureUseSpend,
  TokenUsage,
  Wait,
} from '../types.ts'
import { addUsage } from '../usage.ts'
import { CAPTURE_KEYS, type ChromeSession, navigateAndWait } from './browser.ts'
import {
  describeChange,
  differing,
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
}

/** Where a journey is, for the messages that stop it. */
type Step = { goal: string; index: number; total: number; moves: number }

/** The capture's budget, and what the journey is doing when it runs out. */
type Clock = { budgetMs: number; remaining: () => number; detail: string; step?: Step }

function timedOut(clock: Clock): Error {
  const { step } = clock
  const where = step
    ? ` (instruction ${step.index} of ${step.total}, after ${plural(step.moves, 'move')})`
    : ''
  return new Error(
    `c.capture() timed out on ${clock.detail}${where}: it used all of its ${formatDuration(clock.budgetMs)} timeout. Raise timeout on the call or capture.timeout.`,
  )
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
    screenshot: (fullPage) => race(clock, () => session.screenshot(fullPage)),
    dispatch: (action, page) => race(clock, () => session.dispatch(action, page)),
    busy: () => session.busy(),
    dialogs: () => session.dialogs(),
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

/** The action a tool call asks for, or why it can't be made. */
export function actionFromTool(
  name: string,
  input: Record<string, unknown>,
): CaptureUseAction | { refused: string } {
  if (name === 'done') return { type: 'done' }
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

/** Scales an action's 0–1000 points to CSS pixels on a `page`-sized screenshot. */
export function scalePoints(
  action: CaptureUseAction,
  page: { width: number; height: number },
): CaptureUseAction {
  const x = (n: number) => Math.round((n * page.width) / NORMALIZED)
  const y = (n: number) => Math.round((n * page.height) / NORMALIZED)
  switch (action.type) {
    case 'click':
    case 'hover':
    case 'scroll':
      return { ...action, x: x(action.x), y: y(action.y) }
    case 'drag':
      return { ...action, x: x(action.x), y: y(action.y), toX: x(action.toX), toY: y(action.toY) }
    default:
      return action
  }
}

export const systemPrompt = (normalized: boolean) =>
  `You drive a web page from screenshots. Call one tool. ${
    normalized
      ? `Coordinates are normalized to 0-${NORMALIZED} on the full-page image: x and toX across its width, y and toY down its height. A scroll's dy is in CSS pixels.`
      : 'Coordinates are CSS pixels on the full-page image.'
  } Each turn you get the goal, what has focus, your earlier moves with what each did, and a fresh screenshot. Click a field before typing into it, and do not repeat a move that already worked. A dropdown (select) never opens in the screenshot: click it once, press ArrowDown or ArrowUp until it shows the option you want, then press Enter to choose it. Call done when the goal is met. Do not mention CDP.`

const useTools = {
  click: tool({
    description: 'Click at (x, y) on the screenshot.',
    inputSchema: z.object({ x: z.number(), y: z.number() }),
  }),
  type: tool({
    description:
      'Insert text into the focused field. Click the field first. Set replace to true to replace what the field already holds instead of adding to it.',
    inputSchema: z.object({ text: z.string(), replace: z.boolean().optional() }),
  }),
  key: tool({
    description:
      'Press a key in the focused element. In a dropdown (select), click it, press ArrowDown or ArrowUp to the option, then Enter to choose it. Space toggles a focused checkbox.',
    inputSchema: z.object({ key: z.enum(CAPTURE_KEYS) }),
  }),
  scroll: tool({
    description: 'Wheel-scroll a constrained scroller at (x, y).',
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
): Promise<number> {
  const goal = step.goal
  let moves = 0
  for (const action of script) {
    clock.step = { ...step, moves }
    check(clock)
    if (action.type === 'done') return moves
    if (moves >= CAPTURE_USE_MOVE_CAP) throw unfinished(step)
    const ephemeral = await session.screenshot(true)
    const page = pngSize(ephemeral)
    debugTrace('check', 'capture-use', { goal, action, page }, `capture use ${action.type}`)
    await session.dispatch(action, page)
    moves++
    await settledState(session, volatile, clock.remaining)
  }
  clock.step = { ...step, moves }
  while (clock.remaining() > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, clock.remaining())))
  }
  throw timedOut(clock)
}

const unfinished = (step: Step) =>
  new Error(
    `c.capture() instruction ${step.index} of ${step.total} ${JSON.stringify(step.goal)} did not finish in ${CAPTURE_USE_MOVE_CAP} moves`,
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
}

const grid = (n: number) => Math.round(n / SAME_POINT)

function moveKey(action: CaptureUseAction): string {
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
  const fields = move.before ? differing(move.before, after, volatile) : []
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
): string {
  const lines = [`Goal: ${step.goal}`]
  if (step.total > 1) {
    lines.push(
      `This is instruction ${step.index} of ${step.total}.${earlier.length ? ` Already done: ${earlier.map((g) => JSON.stringify(g)).join(', ')}.` : ''}`,
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
    lines.push(`${i + 1}. ${m.said}${effect ? ` → ${effect}` : ''}`)
  })
  if (stuckMoves(moves) >= CAPTURE_USE_NUDGE_AT) {
    lines.push(
      'Your last moves repeated the same action and nothing changed. Do not repeat it: if the goal is met, call done; otherwise try a different action.',
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
  loadModel: (name: string) => Promise<unknown>
}

async function runModelGoal(
  session: ChromeSession,
  { step, earlier, origin, modelName, clock, volatile, pristine, loadModel }: Goal,
): Promise<{ moves: number; usage: TokenUsage | null }> {
  const { goal } = step
  const model = await loadModel(modelName)
  const normalized = normalizesPoints(modelName)
  const made: Move[] = []
  let dispatched = 0
  let usage: TokenUsage | null = null
  let now = await probePage(session)
  let stale = 0
  while (made.length < CAPTURE_USE_MOVE_CAP) {
    clock.step = { ...step, moves: dispatched }
    check(clock)
    const last = made.at(-1)
    if (last?.after) {
      // A change that lands after the move settled is still that move's.
      const late = await probePage(session)
      last.dialogs.push(...session.dialogs())
      if (differing(last.after, late, volatile).length || last.dialogs.length) {
        settleMove(last, late, origin, volatile)
      }
      now = late
    }
    const stuck = stuckMoves(made)
    if (stuck >= CAPTURE_USE_STUCK_AT) {
      throw new Error(
        `c.capture() instruction ${step.index} of ${step.total} ${JSON.stringify(goal)} repeated ${last?.said} ${CAPTURE_USE_STUCK_AT} times and nothing changed`,
      )
    }
    const ephemeral = await session.screenshot(true)
    const page = pngSize(ephemeral)
    debugTrace(
      'check',
      'capture-shot',
      { goal, bytes: ephemeral.length, page, url: now.url },
      false,
    )
    const signal = AbortSignal.timeout(check(clock))
    const asked = Date.now()
    const result = await race(clock, () =>
      generateText({
        model: model as never,
        system: systemPrompt(normalized),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: goalPrompt(step, earlier, now, made, origin, volatile) },
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
    if (!last) {
      // Before the journey's first move, whatever changes changes on its own.
      if (pristine) for (const f of moved) if (f !== 'url' && f !== 'focus') volatile.add(f)
    } else if ((moved.length || opened.length) && stale < STALE_ASKS) {
      stale++
      if (!last.refused) {
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
    let asks = actionFromTool(call.toolName, input)
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
    const chosen = normalized ? scalePoints(asks, page) : asks
    debugLog('check', `capture use ${logged} on ${JSON.stringify(goal)} · ${latency}`)
    debugTrace('check', 'capture-use', { goal, action: chosen, page }, `capture use ${chosen.type}`)
    if (chosen.type === 'done') return { moves: dispatched, usage }
    const move: Move = { said, key: moveKey(asks), before: now, dialogs: [] }
    made.push(move)
    await session.dispatch(chosen, page)
    dispatched++
    now = await settledState(session, volatile, clock.remaining)
    move.dialogs.push(...session.dialogs())
    settleMove(move, now, origin, volatile)
  }
  throw unfinished(step)
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
    if (use && 'fake' in use) {
      const script = use.fake[stringIndex] ?? []
      moves += await runFakeScript(session, script, step, clock, volatile)
    } else if (use && 'model' in use) {
      if (!options.loadModel) {
        throw new Error('c.capture() instructions need a model loader')
      }
      const ran = await runModelGoal(session, {
        step,
        earlier: goals.slice(0, stringIndex),
        origin,
        modelName: use.model,
        clock,
        volatile,
        pristine: moves === 0,
        loadModel: options.loadModel,
      })
      moves += ran.moves
      usage = addUsage(usage, ran.usage)
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
