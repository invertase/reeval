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
import { type ChromeSession, navigateAndWait } from './browser.ts'
import { pageChanged } from './png.ts'
import { pngSize } from './stub.ts'

/** Silent cap per instruction string; not in the eval API. */
export const CAPTURE_USE_MOVE_CAP = 32

/** Identical moves in a row that leave the page as it was: the model is nudged at the first, stopped at the second. */
export const CAPTURE_USE_NUDGE_AT = 2
export const CAPTURE_USE_STUCK_AT = 4

/** Internal settle between moves; not an authored wait. */
const SETTLE_MS = 80

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
type Step = { goal: string; index: number; total: number; moves: number; budgetMs: number }

function timedOut(budgetMs: number, detail: string, step?: Step): Error {
  const where = step
    ? ` (instruction ${step.index} of ${step.total}, after ${plural(step.moves, 'move')})`
    : ''
  return new Error(
    `c.capture() timed out on ${detail}${where}: it used all of its ${formatDuration(budgetMs)} timeout. Raise timeout on the call or capture.timeout.`,
  )
}

function remainingOrThrow(
  remaining: () => number,
  budgetMs: number,
  detail: string,
  step?: Step,
): number {
  const left = remaining()
  if (left <= 0) throw timedOut(budgetMs, detail, step)
  return left
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS))
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

function actionFromTool(name: string, input: Record<string, unknown>): CaptureUseAction {
  if (name === 'done') return { type: 'done' }
  if (name === 'type') return { type: 'type', text: String(input.text ?? '') }
  if (name === 'key') return { type: 'key', key: input.key === 'Tab' ? 'Tab' : 'Enter' }
  if (name === 'scroll') {
    return {
      type: 'scroll',
      x: Number(input.x),
      y: Number(input.y),
      dy: Number(input.dy),
    }
  }
  if (name === 'drag') {
    return {
      type: 'drag',
      x: Number(input.x),
      y: Number(input.y),
      toX: Number(input.toX),
      toY: Number(input.toY),
    }
  }
  if (name === 'hover') return { type: 'hover', x: Number(input.x), y: Number(input.y) }
  return { type: 'click', x: Number(input.x), y: Number(input.y) }
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
  } Each turn you get the goal, your earlier moves with what each did, and a fresh screenshot. Click a field before typing into it, and do not repeat a move that already worked. Call done when the goal is met. Do not mention CDP.`

const useTools = {
  click: tool({
    description: 'Click at (x, y) on the screenshot.',
    inputSchema: z.object({ x: z.number(), y: z.number() }),
  }),
  type: tool({
    description: 'Insert text into the focused field. Click the field first.',
    inputSchema: z.object({ text: z.string() }),
  }),
  key: tool({
    description: 'Press Tab or Enter.',
    inputSchema: z.object({ key: z.enum(['Tab', 'Enter']) }),
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
  remaining: () => number,
): Promise<number> {
  const goal = step.goal
  let moves = 0
  for (const action of script) {
    remainingOrThrow(remaining, step.budgetMs, JSON.stringify(goal), { ...step, moves })
    if (action.type === 'done') return moves
    if (moves >= CAPTURE_USE_MOVE_CAP) throw unfinished(step)
    const ephemeral = await session.screenshot(true)
    const page = pngSize(ephemeral)
    debugTrace('check', 'capture-use', { goal, action, page }, `capture use ${action.type}`)
    await session.dispatch(action, page)
    moves++
    await settle()
  }
  while (remaining() > 0) await settle()
  throw timedOut(step.budgetMs, JSON.stringify(goal), { ...step, moves })
}

const unfinished = (step: Step) =>
  new Error(
    `c.capture() instruction ${step.index} of ${step.total} ${JSON.stringify(step.goal)} did not finish in ${CAPTURE_USE_MOVE_CAP} moves`,
  )

/** One move the model made, and what it did to the page once the next screenshot showed it. */
type Move = { said: string; key: string; from?: string; changed?: boolean; url?: string }

/** The page's path and query on the journey's origin, or its whole URL elsewhere. */
async function currentUrl(session: ChromeSession, origin: string): Promise<string | undefined> {
  const history = (await session.cdp.send('Page.getNavigationHistory').catch(() => undefined)) as
    | { currentIndex?: number; entries?: Array<{ url?: string }> }
    | undefined
  const url = history?.entries?.[history.currentIndex ?? -1]?.url
  if (!url) return undefined
  return url.startsWith(`${origin}/`) ? url.slice(origin.length) : url
}

/** The identical moves at the end of `moves` that each left the page as it was. */
function stuckMoves(moves: readonly Move[]): number {
  const last = moves.at(-1)
  let n = 0
  for (let i = moves.length - 1; i >= 0; i--) {
    const move = moves[i]
    if (move?.key !== last?.key || move?.changed !== false) break
    n++
  }
  return n
}

/** The goal, where the journey is, and the moves so far with what each did. */
export function goalPrompt(
  step: Pick<Step, 'goal' | 'index' | 'total'>,
  earlier: readonly string[],
  url: string | undefined,
  moves: readonly Move[],
): string {
  const lines = [`Goal: ${step.goal}`]
  if (step.total > 1) {
    lines.push(
      `This is instruction ${step.index} of ${step.total}.${earlier.length ? ` Already done: ${earlier.map((g) => JSON.stringify(g)).join(', ')}.` : ''}`,
    )
  }
  if (url) lines.push(`The page is at ${url}.`)
  if (!moves.length) {
    lines.push('You have made no moves for this goal yet.')
    return lines.join('\n')
  }
  lines.push('Your moves for this goal so far, oldest first. The screenshot shows the page now.')
  moves.forEach((m, i) => {
    const effect =
      m.changed === undefined
        ? ''
        : m.changed
          ? ` → the page changed${m.url && m.url !== m.from ? `, now at ${m.url}` : ''}`
          : ' → the page did not change'
    lines.push(`${i + 1}. ${m.said}${effect}`)
  })
  if (stuckMoves(moves) >= CAPTURE_USE_NUDGE_AT) {
    lines.push(
      'Your last moves repeated the same action without changing the page. Do not repeat it: if the goal is met, call done; otherwise try a different action.',
    )
  }
  return lines.join('\n')
}

type Goal = {
  step: Step
  earlier: readonly string[]
  origin: string
  modelName: string
  remaining: () => number
  loadModel: (name: string) => Promise<unknown>
}

async function runModelGoal(
  session: ChromeSession,
  { step, earlier, origin, modelName, remaining, loadModel }: Goal,
): Promise<{ moves: number; usage: TokenUsage | null }> {
  const { goal } = step
  const model = await loadModel(modelName)
  const normalized = normalizesPoints(modelName)
  const made: Move[] = []
  let usage: TokenUsage | null = null
  let before: Buffer | undefined
  while (made.length < CAPTURE_USE_MOVE_CAP) {
    const at = { ...step, moves: made.length }
    remainingOrThrow(remaining, step.budgetMs, JSON.stringify(goal), at)
    const ephemeral = await session.screenshot(true)
    const page = pngSize(ephemeral)
    const url = await currentUrl(session, origin)
    const last = made.at(-1)
    if (last && before) {
      last.url = url
      last.changed = pageChanged(before, ephemeral) || url !== last.from
    }
    before = ephemeral
    if (stuckMoves(made) >= CAPTURE_USE_STUCK_AT) {
      throw new Error(
        `c.capture() instruction ${step.index} of ${step.total} ${JSON.stringify(goal)} repeated ${last?.said} ${CAPTURE_USE_STUCK_AT} times without the page changing`,
      )
    }
    debugTrace('check', 'capture-shot', { goal, bytes: ephemeral.length, page, url }, false)
    const signal = AbortSignal.timeout(
      remainingOrThrow(remaining, step.budgetMs, JSON.stringify(goal), at),
    )
    const asked = Date.now()
    const result = await generateText({
      model: model as never,
      system: systemPrompt(normalized),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: goalPrompt(step, earlier, url, made) },
            { type: 'file', mediaType: 'image/png', data: ephemeral },
          ],
        },
      ],
      tools: useTools,
      toolChoice: 'required',
      stopWhen: stepCountIs(1),
      abortSignal: signal,
    }).catch((error: unknown) => {
      throw signal.aborted ? timedOut(step.budgetMs, JSON.stringify(goal), at) : error
    })
    usage = addUsage(usage, asUsage(result.usage ?? {}))
    const call = result.toolCalls?.[0]
    let chosen = call
      ? actionFromTool(call.toolName, (call.input ?? {}) as Record<string, unknown>)
      : undefined
    if (!call || !chosen) {
      throw new Error(`c.capture() instruction ${JSON.stringify(goal)} returned no action`)
    }
    const said = `${call.toolName} ${JSON.stringify(call.input ?? {})}`
    if (normalized) chosen = scalePoints(chosen, page)
    debugLog(
      'check',
      `capture use ${said} on ${JSON.stringify(goal)} · ${formatDuration(Date.now() - asked)}`,
    )
    debugTrace('check', 'capture-use', { goal, action: chosen, page }, `capture use ${chosen.type}`)
    if (chosen.type === 'done') return { moves: made.length, usage }
    await session.dispatch(chosen, page)
    made.push({ said, key: JSON.stringify(chosen), from: url })
    await settle()
  }
  throw unfinished(step)
}

/**
 * Top-level wait, then the instruction loop, then the saved PNG.
 * Throws before `screenshot` when the budget or move cap is hit.
 */
export async function runJourney(
  session: ChromeSession,
  url: string,
  options: JourneyOptions,
): Promise<JourneyResult> {
  const { wait, timeoutMs, fullPage, instructions, use, remaining } = options
  const budgetMs = options.budgetMs ?? timeoutMs
  const origin = new URL(url).origin
  remainingOrThrow(remaining, budgetMs, 'navigate')
  await navigateAndWait(session, url, wait, Math.min(timeoutMs, remaining()))
  const goals = instructions.filter((s): s is string => typeof s === 'string')
  let moves = 0
  let usage: TokenUsage | null = null
  let stringIndex = 0
  for (const instruction of instructions) {
    if (typeof instruction !== 'string') {
      remainingOrThrow(remaining, budgetMs, 'wait')
      await session.wait(instruction.wait, remaining(), undefined)
      continue
    }
    const step: Step = {
      goal: instruction,
      index: stringIndex + 1,
      total: goals.length,
      moves: 0,
      budgetMs,
    }
    remainingOrThrow(remaining, budgetMs, JSON.stringify(instruction), step)
    debugLog(
      'check',
      `capture instruction ${step.index} of ${step.total} ${JSON.stringify(instruction)}`,
    )
    if (use && 'fake' in use) {
      const script = use.fake[stringIndex] ?? []
      moves += await runFakeScript(session, script, step, remaining)
    } else if (use && 'model' in use) {
      if (!options.loadModel) {
        throw new Error('c.capture() instructions need a model loader')
      }
      const ran = await runModelGoal(session, {
        step,
        earlier: goals.slice(0, stringIndex),
        origin,
        modelName: use.model,
        remaining,
        loadModel: options.loadModel,
      })
      moves += ran.moves
      usage = addUsage(usage, ran.usage)
    }
    stringIndex++
    await settle()
  }
  remainingOrThrow(remaining, budgetMs, 'screenshot')
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
