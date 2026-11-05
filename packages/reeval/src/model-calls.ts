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
  stream?: true
}

const n = (fields: Record<string, number>, key: string) => fields[key] ?? 0

/**
 * The tokens a model call's response named, as reeval counts them: `input` without cache reads
 * and writes, and `output` with reasoning. Each API counts its own way: Anthropic's `input_tokens`
 * leaves the cache out; OpenAI's (Responses and Chat Completions) and Gemini's prompt counts
 * include cache reads; Gemini's `candidatesTokenCount` leaves its thoughts out. Null when it
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
      reasoning: null,
    }
  }
  const cached = n(fields, 'cached_tokens')
  const prompt = 'prompt_tokens' in fields ? 'prompt_tokens' : 'input_tokens'
  const output = 'completion_tokens' in fields ? 'completion_tokens' : 'output_tokens'
  return {
    input: Math.max(0, n(fields, prompt) - cached),
    output: n(fields, output),
    cacheRead: cached,
    cacheWrite: 0,
    reasoning: fields.reasoning_tokens ?? null,
  }
}

/**
 * The calls that started within a turn, as transcript events on its clock: `turnStartedAt` in
 * epoch ms, `turnMs` its length. A call the turn's end cut short keeps its own length.
 */
export function modelCallEvents(
  calls: readonly ModelCall[],
  turnStartedAt: number,
  turnMs: number,
): Array<EventTime & ModelCallEvent> {
  return calls
    .filter((c) => c.startedAt >= turnStartedAt && c.startedAt <= turnStartedAt + turnMs)
    .map((c) => ({
      ts: new Date(c.startedAt).toISOString(),
      atMs: c.startedAt - turnStartedAt,
      type: 'model-call',
      request: c.request,
      status: c.status,
      durationMs: c.ms,
      firstByteMs: c.firstByteMs,
      usage: c.usage,
      model: c.model,
      ...(c.stream ? { stream: true as const } : {}),
    }))
}
