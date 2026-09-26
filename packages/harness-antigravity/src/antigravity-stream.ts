import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import type { JSONValue } from '@ai-sdk/provider'
import { projectToolCall } from './antigravity-tools.ts'

/**
 * Token counts as the CLI reports them. `input_tokens` excludes `cache_read_tokens` (reads are
 * often larger), and `output_tokens` includes `thinking_tokens`.
 */
export type AntigravityUsage = {
  input_tokens?: number
  output_tokens?: number
  thinking_tokens?: number
  cache_read_tokens?: number
  total_tokens?: number
}

export type AntigravityResult = {
  conversation_id?: string
  status?: string
  response?: string
  error?: string
  duration_seconds?: number
  num_turns?: number
  usage?: AntigravityUsage
  structured_output?: JSONValue
}

export type AntigravityStepUpdate = {
  conversation_id?: string
  step_index?: number
  state?: string
  step_type?: string
  tool_name?: string
  text_delta?: string
  duration_seconds?: number
  usage?: AntigravityUsage
  tool_info?: {
    name?: string
    parameters?: Record<string, unknown>
    output?: JSONValue
    error?: { type?: string; message?: string }
  }
}

/** One line of `agy --output-format stream-json`. */
export type AntigravityEvent =
  | {
      event: 'init'
      conversation_id?: string
      init?: { model?: string; cwd?: string; tools?: string[]; permission_mode?: string }
    }
  | { event: 'step_update'; step_update?: AntigravityStepUpdate }
  | { event: 'result'; result?: AntigravityResult }

type Usage = Extract<HarnessV1StreamPart, { type: 'finish' }>['totalUsage']
type FinishReason = Extract<HarnessV1StreamPart, { type: 'finish' }>['finishReason']

/** Maps the CLI's counts onto the AI SDK's usage shape, keeping the original under `raw`. */
export function toUsage(usage: AntigravityUsage | undefined): Usage {
  const noCache = usage?.input_tokens
  const cacheRead = usage?.cache_read_tokens
  const output = usage?.output_tokens
  const reasoning = usage?.thinking_tokens
  return {
    inputTokens: {
      total: noCache !== undefined ? noCache + (cacheRead ?? 0) : undefined,
      noCache,
      cacheRead,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: output,
      text: output !== undefined && reasoning !== undefined ? output - reasoning : undefined,
      reasoning,
    },
    ...(usage ? { raw: { ...usage } } : {}),
  }
}

const FINISH: Record<string, FinishReason['unified']> = {
  SUCCESS: 'stop',
  ERROR: 'error',
}

const TERMINAL_TOOL_STATES = new Set(['DONE', 'ERROR', 'CANCELED', 'CANCELLED'])

/**
 * Turns one `agy` process's NDJSON into harness stream parts, in order. The CLI reports no
 * tool-call ids, so a call is identified by its conversation and step index.
 */
export class AntigravityStreamTranslator {
  conversationId: string | undefined
  private started = false
  private finished = false
  private sawText = false
  private openText = new Set<number>()
  private openTools = new Map<
    number,
    { toolCallId: string; toolName: string; nativeName: string; dynamic: boolean }
  >()
  private pendingStep: AntigravityUsage | undefined
  private stepUsage = false
  private readonly turn: number

  constructor(options: { turn: number; conversationId?: string | undefined }) {
    this.turn = options.turn
    this.conversationId = options.conversationId
  }

  /** Parts for one stdout line. Lines that aren't JSON events are passed through as raw. */
  push(line: string): HarnessV1StreamPart[] {
    const trimmed = line.trim()
    if (!trimmed) return []
    let event: AntigravityEvent
    try {
      event = JSON.parse(trimmed)
    } catch {
      return [{ type: 'raw', rawValue: { unparsed: trimmed } }]
    }
    if (this.finished) return [{ type: 'raw', rawValue: event }]
    const parts: HarnessV1StreamPart[] = []
    if (event.event === 'init') {
      this.conversationId = event.conversation_id ?? this.conversationId
      this.start(parts, event.init?.model)
    } else if (event.event === 'step_update' && event.step_update) {
      this.start(parts)
      this.step(parts, event.step_update)
    } else if (event.event === 'result') {
      this.start(parts)
      this.result(parts, event.result ?? {})
    }
    parts.push({ type: 'raw', rawValue: event })
    return parts
  }

  /** Closes the turn when the process ends without a `result` (killed, crashed, aborted). */
  end(options: { exitCode: number; stderr?: string; aborted?: boolean }): HarnessV1StreamPart[] {
    if (this.finished) return []
    const parts: HarnessV1StreamPart[] = []
    this.start(parts)
    for (const call of this.openTools.values()) {
      parts.push(
        this.toolResult(call, `${call.nativeName} ${options.aborted ? 'aborted' : 'interrupted'}`),
      )
    }
    this.openTools.clear()
    this.closeBlocks(parts)
    if (!options.aborted) {
      const detail = options.stderr?.trim()
      parts.push({
        type: 'error',
        error: new Error(
          `The Antigravity CLI exited with code ${options.exitCode} before reporting a result${detail ? `: ${detail}` : ''}`,
        ),
      })
    }
    this.finished = true
    parts.push({
      type: 'finish',
      finishReason: options.aborted
        ? { unified: 'other', raw: 'aborted' }
        : { unified: 'error', raw: `exit ${options.exitCode}` },
      totalUsage: toUsage(undefined),
    })
    return parts
  }

  private start(parts: HarnessV1StreamPart[], modelId?: string) {
    if (this.started) return
    this.started = true
    parts.push({ type: 'stream-start', ...(modelId ? { modelId } : {}) })
  }

  private id(step: number) {
    return `agy-${this.conversationId ?? `turn${this.turn}`}-${step}`
  }

  private toolResult(
    call: { toolCallId: string; toolName: string; dynamic: boolean },
    error: string | undefined,
    output: NonNullable<JSONValue> = '',
  ): HarnessV1StreamPart {
    return {
      type: 'tool-result',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      result: error ?? output,
      ...(error !== undefined ? { isError: true } : {}),
      ...(call.dynamic ? { dynamic: true } : {}),
    }
  }

  private flushStep(parts: HarnessV1StreamPart[], next: 'tool-calls' | 'stop') {
    if (!this.pendingStep) return
    parts.push({
      type: 'finish-step',
      finishReason: { unified: next, raw: 'agent_response' },
      usage: toUsage(this.pendingStep),
    })
    this.pendingStep = undefined
  }

  private closeBlocks(parts: HarnessV1StreamPart[]) {
    for (const step of this.openText) parts.push({ type: 'text-end', id: `text-${step}` })
    this.openText.clear()
    this.flushStep(parts, 'stop')
  }

  private step(parts: HarnessV1StreamPart[], s: AntigravityStepUpdate) {
    const index = s.step_index ?? -1
    this.conversationId ??= s.conversation_id
    if (s.step_type === 'agent_response') {
      if (s.text_delta) {
        if (!this.openText.has(index)) {
          this.flushStep(parts, 'stop')
          this.openText.add(index)
          parts.push({ type: 'text-start', id: `text-${index}` })
        }
        this.sawText = true
        parts.push({ type: 'text-delta', id: `text-${index}`, delta: s.text_delta })
      }
      if (s.state !== 'ACTIVE') {
        if (this.openText.delete(index)) parts.push({ type: 'text-end', id: `text-${index}` })
        if (s.usage) {
          this.flushStep(parts, 'stop')
          this.pendingStep = s.usage
          this.stepUsage = true
        }
      }
      return
    }
    if (s.step_type === 'tool') {
      this.flushStep(parts, 'tool-calls')
      const info = s.tool_info ?? {}
      const nativeName = info.name ?? s.tool_name ?? 'unknown'
      let call = this.openTools.get(index)
      if (!call) {
        const projected = projectToolCall(nativeName, info.parameters)
        call = { ...projected, toolCallId: this.id(index) }
        this.openTools.set(index, call)
        parts.push({
          type: 'tool-call',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: JSON.stringify(projected.input),
          providerExecuted: true,
          ...(call.dynamic ? { dynamic: true } : {}),
          ...(call.toolName !== nativeName ? { nativeName } : {}),
        })
      }
      if (s.state && TERMINAL_TOOL_STATES.has(s.state)) {
        this.openTools.delete(index)
        const failed = s.state !== 'DONE' || info.error !== undefined
        parts.push(
          this.toolResult(
            call,
            failed ? (info.error?.message ?? `${nativeName} ${s.state.toLowerCase()}`) : undefined,
            info.output ?? '',
          ),
        )
      }
    }
  }

  private result(parts: HarnessV1StreamPart[], r: AntigravityResult) {
    this.conversationId = r.conversation_id || this.conversationId
    if (!this.sawText && r.response) {
      parts.push({ type: 'text-start', id: 'text-result' })
      parts.push({ type: 'text-delta', id: 'text-result', delta: r.response })
      parts.push({ type: 'text-end', id: 'text-result' })
    }
    this.closeBlocks(parts)
    if (!this.stepUsage && r.usage) {
      parts.push({
        type: 'finish-step',
        finishReason: { unified: 'stop', raw: 'result' },
        usage: toUsage(r.usage),
      })
    }
    const status = r.status ?? 'UNKNOWN'
    if (status !== 'SUCCESS') {
      parts.push({
        type: 'error',
        error: new Error(r.error || `The Antigravity CLI ended the turn with status ${status}`),
      })
    }
    this.finished = true
    parts.push({
      type: 'finish',
      finishReason: { unified: FINISH[status] ?? 'other', raw: status },
      totalUsage: toUsage(r.usage),
      ...(r.structured_output !== undefined
        ? { harnessMetadata: { antigravity: { structuredOutput: r.structured_output } } }
        : {}),
    })
  }
}
