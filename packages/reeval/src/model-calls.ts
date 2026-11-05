// The agent's model calls, as the egress gateway timed them: collected on the worker for the
// whole attempt, then placed in the turn they started in as `model-call` transcript events.
import type { EventTime, ModelCallEvent, TokenUsage } from './types.ts'

/** One model call, on the worker's clock (epoch ms). */
export type ModelCall = {
  startedAt: number
  ms: number
  firstByteMs: number | null
  request: string
  status: number | null
  usage: TokenUsage | null
  model: string | null
  /** How many tools its request declared; null when the gateway couldn't read it. */
  tools: number | null
  stream?: true
}

const n = (fields: Record<string, number>, key: string) => fields[key] ?? 0

/**
 * The tokens a model call's response named, as reeval counts them: `input` without cache reads
 * and writes, and `output` with reasoning. Each API counts its own way: Anthropic's `input_tokens`
 * leaves the cache out, and its `thinking_tokens` are in `output_tokens`; OpenAI's (Responses and
 * Chat Completions) and Gemini's prompt counts include cache reads, and the Responses API's include
 * its `cache_write_tokens`; Gemini's `candidatesTokenCount` leaves its thoughts out. Null when it
 * named none.
 */
export function callUsage(fields: Record<string, number> | undefined): TokenUsage | null {
  if (!fields || Object.keys(fields).length === 0) return null
  if ('promptTokenCount' in fields || 'candidatesTokenCount' in fields) {
    const cached = n(fields, 'cachedContentTokenCount')
    const thoughts = fields.thoughtsTokenCount
    return {
      input: Math.max(0, n(fields, 'promptTokenCount') - cached),
      output: n(fields, 'candidatesTokenCount') + (thoughts ?? 0),
      cacheRead: cached,
      cacheWrite: 0,
      reasoning: thoughts ?? null,
    }
  }
  if ('cache_read_input_tokens' in fields || 'cache_creation_input_tokens' in fields) {
    return {
      input: n(fields, 'input_tokens'),
      output: n(fields, 'output_tokens'),
      cacheRead: n(fields, 'cache_read_input_tokens'),
      cacheWrite: n(fields, 'cache_creation_input_tokens'),
      reasoning: fields.thinking_tokens ?? null,
    }
  }
  const cached = n(fields, 'cached_tokens')
  const written = n(fields, 'cache_write_tokens')
  const prompt = 'prompt_tokens' in fields ? 'prompt_tokens' : 'input_tokens'
  const output = 'completion_tokens' in fields ? 'completion_tokens' : 'output_tokens'
  return {
    input: Math.max(0, n(fields, prompt) - cached - written),
    output: n(fields, output),
    cacheRead: cached,
    cacheWrite: written,
    reasoning: fields.reasoning_tokens ?? null,
  }
}

/** One turn, as `modelCallEvents` places calls in it. */
export type CallTurn = {
  /** Epoch ms. */
  startedAt: number
  durationMs: number
  /** The model the harness or the gateway says served the turn. */
  model: string | null
  /** The tokens of each step the harness reported, in order; empty when it reported none. */
  steps: readonly TokenUsage[]
}

const sameTokens = (a: TokenUsage, b: TokenUsage) =>
  a.input === b.input &&
  a.output === b.output &&
  a.cacheRead === b.cacheRead &&
  a.cacheWrite === b.cacheWrite

/**
 * The turn's own model when one of its calls names it; otherwise the model most of its calls
 * name, counting those that declared more than one tool when there are any.
 */
function mainModel(calls: readonly ModelCall[], turnModel: string | null): string | null {
  if (turnModel && calls.some((c) => c.model === turnModel)) return turnModel
  const full = calls.filter((c) => c.tools === null || c.tools > 1)
  const tally = new Map<string, number>()
  for (const c of full.length ? full : calls) {
    if (c.model) tally.set(c.model, (tally.get(c.model) ?? 0) + 1)
  }
  return [...tally].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null
}

/** Each of a turn's calls' role; see `ModelCallEvent.role`. */
function roles(
  calls: readonly ModelCall[],
  turn: CallTurn,
  toolful: boolean,
): Array<'main' | 'side'> {
  const steps = [...turn.steps]
  const stepped = calls.map((c) => {
    const i = c.usage ? steps.findIndex((s) => sameTokens(s, c.usage as TokenUsage)) : -1
    if (i !== -1) steps.splice(i, 1)
    return i !== -1
  })
  const model = mainModel(calls, turn.model)
  return calls.map((c, i) => {
    if (c.stream || stepped[i]) return 'main'
    if (toolful && c.tools !== null && c.tools <= 1) return 'side'
    return c.model && model && c.model !== model ? 'side' : 'main'
  })
}

/**
 * The calls that started within a turn, as transcript events on its clock, each with its role.
 * `calls` is the whole attempt's: a call declaring tools anywhere in it tells the tool-less calls
 * in this turn apart. A call the turn's end cut short keeps its own length.
 */
export function modelCallEvents(
  calls: readonly ModelCall[],
  turn: CallTurn,
): Array<EventTime & ModelCallEvent> {
  const toolful = calls.some((c) => c.tools !== null && c.tools > 1)
  const mine = calls.filter(
    (c) => c.startedAt >= turn.startedAt && c.startedAt <= turn.startedAt + turn.durationMs,
  )
  const role = roles(mine, turn, toolful)
  return mine.map((c, i) => ({
    ts: new Date(c.startedAt).toISOString(),
    atMs: c.startedAt - turn.startedAt,
    type: 'model-call',
    request: c.request,
    status: c.status,
    durationMs: c.ms,
    firstByteMs: c.firstByteMs,
    usage: c.usage,
    model: c.model,
    ...(c.stream ? { stream: true as const } : {}),
    role: role[i] ?? 'main',
  }))
}
