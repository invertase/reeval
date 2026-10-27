// Vision journey on an open Chrome session: one string is a goal, `{ wait }` is a beat.
// The model sees an ephemeral full-page PNG and returns tools; handlers send Input.*.
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { debugLog, debugTrace } from '../debug/attempt.ts'
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
import { pngSize } from './stub.ts'

/** Silent cap per instruction string; not in the eval API. */
export const CAPTURE_USE_MOVE_CAP = 32

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
}

function remainingOrThrow(remaining: () => number, detail: string): number {
  const left = remaining()
  if (left <= 0) throw new Error(`c.capture() timed out on ${detail}`)
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

const systemPrompt = (normalized: boolean) =>
  `You drive a web page from screenshots. Call one tool. ${
    normalized
      ? `Coordinates are normalized to 0-${NORMALIZED} on the full-page image: x and toX across its width, y and toY down its height. A scroll's dy is in CSS pixels.`
      : 'Coordinates are CSS pixels on the full-page image.'
  } Call done when the goal is met. Do not mention CDP.`

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
  goal: string,
  remaining: () => number,
): Promise<number> {
  let moves = 0
  for (const action of script) {
    remainingOrThrow(remaining, JSON.stringify(goal))
    if (action.type === 'done') return moves
    if (moves >= CAPTURE_USE_MOVE_CAP) {
      throw new Error(
        `c.capture() instruction ${JSON.stringify(goal)} did not finish in ${CAPTURE_USE_MOVE_CAP} moves`,
      )
    }
    const ephemeral = await session.screenshot(true)
    const page = pngSize(ephemeral)
    debugTrace('check', 'capture-use', { goal, action, page }, `capture use ${action.type}`)
    await session.dispatch(action, page)
    moves++
    await settle()
  }
  while (remaining() > 0) await settle()
  throw new Error(`c.capture() timed out on ${JSON.stringify(goal)}`)
}

async function runModelGoal(
  session: ChromeSession,
  goal: string,
  modelName: string,
  remaining: () => number,
  loadModel: (name: string) => Promise<unknown>,
): Promise<{ moves: number; usage: TokenUsage | null }> {
  const model = await loadModel(modelName)
  const normalized = normalizesPoints(modelName)
  let moves = 0
  let usage: TokenUsage | null = null
  while (moves < CAPTURE_USE_MOVE_CAP) {
    remainingOrThrow(remaining, JSON.stringify(goal))
    const ephemeral = await session.screenshot(true)
    const page = pngSize(ephemeral)
    debugTrace('check', 'capture-shot', { goal, bytes: ephemeral.length, page }, false)
    let chosen: CaptureUseAction | undefined
    const result = await generateText({
      model: model as never,
      system: systemPrompt(normalized),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: goal },
            { type: 'image', image: ephemeral },
          ],
        },
      ],
      tools: useTools,
      toolChoice: 'required',
      stopWhen: stepCountIs(1),
      abortSignal: AbortSignal.timeout(remainingOrThrow(remaining, JSON.stringify(goal))),
    })
    usage = addUsage(usage, asUsage(result.usage ?? {}))
    const call = result.toolCalls?.[0]
    if (call) chosen = actionFromTool(call.toolName, (call.input ?? {}) as Record<string, unknown>)
    if (chosen && normalized) chosen = scalePoints(chosen, page)
    if (!chosen) {
      throw new Error(`c.capture() instruction ${JSON.stringify(goal)} returned no action`)
    }
    debugLog('check', `capture use ${chosen.type} on ${JSON.stringify(goal)}`)
    debugTrace('check', 'capture-use', { goal, action: chosen, page }, `capture use ${chosen.type}`)
    if (chosen.type === 'done') return { moves, usage }
    await session.dispatch(chosen, page)
    moves++
    await settle()
  }
  throw new Error(
    `c.capture() instruction ${JSON.stringify(goal)} did not finish in ${CAPTURE_USE_MOVE_CAP} moves`,
  )
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
  remainingOrThrow(remaining, 'navigate')
  await navigateAndWait(session, url, wait, Math.min(timeoutMs, remaining()))
  let moves = 0
  let usage: TokenUsage | null = null
  let stringIndex = 0
  for (const step of instructions) {
    if (typeof step !== 'string') {
      remainingOrThrow(remaining, 'wait')
      await session.wait(step.wait, remaining(), undefined)
      continue
    }
    remainingOrThrow(remaining, JSON.stringify(step))
    debugLog('check', `capture instruction ${JSON.stringify(step)}`)
    if (use && 'fake' in use) {
      const script = use.fake[stringIndex] ?? []
      moves += await runFakeScript(session, script, step, remaining)
    } else if (use && 'model' in use) {
      if (!options.loadModel) {
        throw new Error('c.capture() instructions need a model loader')
      }
      const ran = await runModelGoal(session, step, use.model, remaining, options.loadModel)
      moves += ran.moves
      usage = addUsage(usage, ran.usage)
    }
    stringIndex++
    await settle()
  }
  remainingOrThrow(remaining, 'screenshot')
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
