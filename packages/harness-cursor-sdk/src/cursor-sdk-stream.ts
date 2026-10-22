import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import type { JSONValue } from '@ai-sdk/provider'
import { CURSOR_SDK_RECOVERED_TOOLS } from './cursor-sdk-bootstrap.ts'
import { projectToolCall, projectToolResult } from './cursor-sdk-tools.ts'

/**
 * The SDK's `TokenUsage`. `inputTokens` already contains `cacheReadTokens` (Cursor's usage export
 * lists the same turn as uncached input plus cache read, and the SDK's `inputTokens` is their sum),
 * so `totalTokens`, which adds the cache reads again, is not used. Cache writes are separate from
 * `inputTokens`. `reasoningTokens` is part of `outputTokens`.
 */
export type CursorSdkUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
  reasoningTokens?: number
}

export type CursorSdkModel = { id: string; params?: Array<{ id: string; value: string }> }

/** An `SDKMessage` from `run.stream()`, loosely: the SDK calls tool args and results unstable. */
export type CursorSdkMessage = {
  type: string
  agent_id?: string
  run_id?: string
  text?: string
  thinking_duration_ms?: number
  message?: { content?: Array<{ type: string; text?: string }> }
  call_id?: string
  name?: string
  status?: string
  args?: unknown
  result?: unknown
  truncated?: { args?: boolean; result?: boolean }
  usage?: CursorSdkUsage
  /** Epoch ms, on calls the runner recovered from the stored conversation after the turn. */
  started_at_ms?: number
  completed_at_ms?: number
}

export type CursorSdkResult = {
  agentId?: string
  runId?: string
  requestId?: string
  status?: 'finished' | 'error' | 'cancelled' | string
  result?: string
  error?: { message?: string; code?: string }
  model?: CursorSdkModel
  durationMs?: number
  usage?: CursorSdkUsage
}

/** One line the in-sandbox runner prints. */
export type CursorSdkRunnerLine =
  | { type: 'init'; turn?: number; agentId: string; model?: CursorSdkModel; sdkVersion?: string }
  | { type: 'event'; event: CursorSdkMessage; recovered?: string }
  /** The runner couldn't recover these tools' calls from the stored conversation this turn. */
  | { type: 'unreported'; turn?: number; tools: string[]; message?: string }
  | ({ type: 'result' } & CursorSdkResult)
  | { type: 'error'; turn?: number; message: string; name?: string; code?: string; status?: number }

type Usage = Extract<HarnessV1StreamPart, { type: 'finish' }>['totalUsage']

/** Parts that are a step's content, as opposed to the stream's framing. */
const isContent = (part: HarnessV1StreamPart) =>
  !['raw', 'stream-start', 'finish', 'finish-step', 'error'].includes(part.type)
type FinishReason = Extract<HarnessV1StreamPart, { type: 'finish' }>['finishReason']

/** Maps the SDK's counts onto the AI SDK's usage shape, keeping the original under `raw`. */
export function toUsage(usage: CursorSdkUsage | undefined): Usage {
  if (!usage) {
    return {
      inputTokens: {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    }
  }
  const read = usage.inputTokens
  const cacheRead = usage.cacheReadTokens
  const cacheWrite = usage.cacheWriteTokens
  const output = usage.outputTokens
  const reasoning = usage.reasoningTokens
  const noCache = read === undefined ? undefined : Math.max(read - (cacheRead ?? 0), 0)
  return {
    inputTokens: {
      total: read === undefined ? undefined : read + (cacheWrite ?? 0),
      noCache,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: output,
      text: output !== undefined && reasoning !== undefined ? output - reasoning : undefined,
      reasoning,
    },
    raw: { ...usage },
  }
}

/** The model as one id, with its parameters: `composer-2.5[fast=false]`. */
export function modelLabel(model: CursorSdkModel | undefined): string | undefined {
  if (!model?.id) return undefined
  const params = model.params ?? []
  return params.length
    ? `${model.id}[${params.map((p) => `${p.id}=${p.value}`).join(',')}]`
    : model.id
}

const FINISH: Record<string, FinishReason['unified']> = {
  finished: 'stop',
  error: 'error',
  cancelled: 'other',
}

/** `webFetch <url>` or `webSearch <query>` for a web tool call, else undefined. */
function webKey(e: CursorSdkMessage): string | undefined {
  const p = projectToolCall(e.name ?? '', e.args)
  if (p.toolName !== 'webFetch' && p.toolName !== 'webSearch') return undefined
  const target = p.input.url ?? p.input.query
  return typeof target === 'string' ? `${p.toolName} ${target}` : undefined
}

/**
 * Turns the runner's NDJSON for one turn into harness stream parts, in order. Text and
 * thinking arrive as deltas; a thinking event with `thinking_duration_ms` ends its block.
 * Each tool call is reported `running` (maybe more than once) and then `completed` or `error`.
 */
export class CursorSdkStreamTranslator {
  agentId: string | undefined
  /** The last `result` line, for callers that want the SDK's own record of the run. */
  result: CursorSdkResult | undefined
  private started = false
  /** True once the turn's `result` or `error` line (or {@link end}) closed it. */
  finished = false
  private sawText = false
  private block = 0
  private openText: string | undefined
  private openReasoning: string | undefined
  private openTools = new Map<string, { toolName: string; dynamic: boolean }>()
  /** Calls already reported, so a late duplicate `completed` doesn't open a second one. */
  private readonly seen = new Set<string>()
  /** Web calls the stream itself reported, by id and by tool and target. */
  private readonly streamedWeb = new Set<string>()
  /**
   * The turn's `usage` event, held until its result line: the runner reports the calls it
   * recovers after it, and HarnessAgent refuses content after a step's `finish-step`.
   */
  private stepUsage: CursorSdkUsage | undefined
  /** Whether the open step has content, which HarnessAgent needs closed before `finish`. */
  private stepHasContent = false
  /** Built-in tools this turn may have used with no `tool_call` reported. */
  private unreportedTools: string[] = []

  private readonly workDir: string | undefined

  /**
   * `workDir`: the agent's workspace. Tool paths under it are reported relative to it, as the
   * ACP adapter reports them; the SDK reports them absolute.
   */
  constructor(options: { agentId?: string | undefined; workDir?: string | undefined } = {}) {
    this.agentId = options.agentId
    this.workDir = options.workDir?.replace(/\/+$/, '')
  }

  private relative(input: Record<string, unknown>): Record<string, unknown> {
    const prefix = this.workDir ? `${this.workDir}/` : undefined
    if (!prefix || typeof input.path !== 'string' || !input.path.startsWith(prefix)) return input
    return { ...input, path: input.path.slice(prefix.length) }
  }

  /** Parts for one stdout line. Lines that aren't runner lines are passed through as raw. */
  push(line: string): HarnessV1StreamPart[] {
    const trimmed = line.trim()
    if (!trimmed) return []
    let parsed: CursorSdkRunnerLine
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return [{ type: 'raw', rawValue: { unparsed: trimmed } }]
    }
    if (this.finished) return [{ type: 'raw', rawValue: parsed }]
    const parts: HarnessV1StreamPart[] = []
    switch (parsed.type) {
      case 'init':
        this.agentId = parsed.agentId ?? this.agentId
        this.start(parts, modelLabel(parsed.model))
        break
      case 'event':
        this.start(parts)
        this.event(parts, parsed.event ?? { type: 'unknown' }, parsed.recovered !== undefined)
        break
      case 'result':
        this.start(parts)
        this.finish(parts, parsed)
        break
      case 'error':
        this.start(parts)
        this.fail(parts, parsed.message, parsed.code ?? parsed.name ?? 'error')
        break
      case 'unreported':
        this.unreportedTools = [...new Set([...this.unreportedTools, ...(parsed.tools ?? [])])]
        break
    }
    parts.push({ type: 'raw', rawValue: parsed })
    if (parts.some(isContent)) this.stepHasContent = true
    return parts
  }

  /** Closes the turn when the runner ends without a result (killed, crashed, aborted). */
  end(options: { exitCode: number; stderr?: string; aborted?: boolean }): HarnessV1StreamPart[] {
    if (this.finished) return []
    const parts: HarnessV1StreamPart[] = []
    this.start(parts)
    this.closeTools(parts, options.aborted ? 'aborted' : 'interrupted')
    this.closeBlocks(parts)
    this.closeStep(parts)
    if (!options.aborted) {
      const detail = options.stderr?.trim()
      parts.push({
        type: 'error',
        error: new Error(
          `The Cursor SDK runner exited with code ${options.exitCode} before reporting a result${detail ? `: ${detail}` : ''}`,
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
      harnessMetadata: this.unrecovered(),
    })
    return parts
  }

  private start(parts: HarnessV1StreamPart[], modelId?: string) {
    if (this.started) return
    this.started = true
    parts.push({ type: 'stream-start', ...(modelId ? { modelId } : {}) })
  }

  private closeText(parts: HarnessV1StreamPart[]) {
    if (this.openText) parts.push({ type: 'text-end', id: this.openText })
    this.openText = undefined
  }

  private closeReasoning(parts: HarnessV1StreamPart[]) {
    if (this.openReasoning) parts.push({ type: 'reasoning-end', id: this.openReasoning })
    this.openReasoning = undefined
  }

  private closeBlocks(parts: HarnessV1StreamPart[]) {
    this.closeText(parts)
    this.closeReasoning(parts)
  }

  private closeTools(parts: HarnessV1StreamPart[], why: string) {
    for (const [toolCallId, call] of this.openTools) {
      parts.push({
        type: 'tool-result',
        toolCallId,
        toolName: call.toolName,
        result: `${call.toolName} ${why}`,
        isError: true,
        ...(call.dynamic ? { dynamic: true } : {}),
      })
    }
    this.openTools.clear()
  }

  private event(parts: HarnessV1StreamPart[], e: CursorSdkMessage, recovered = false) {
    this.agentId ??= e.agent_id
    switch (e.type) {
      case 'thinking': {
        if (e.text) {
          this.closeText(parts)
          if (!this.openReasoning) {
            this.openReasoning = `reasoning-${++this.block}`
            parts.push({ type: 'reasoning-start', id: this.openReasoning })
          }
          parts.push({ type: 'reasoning-delta', id: this.openReasoning, delta: e.text })
        }
        if (e.thinking_duration_ms !== undefined) this.closeReasoning(parts)
        return
      }
      case 'assistant': {
        const text = (e.message?.content ?? [])
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('')
        if (!text) return
        this.closeReasoning(parts)
        if (!this.openText) {
          this.openText = `text-${++this.block}`
          parts.push({ type: 'text-start', id: this.openText })
        }
        this.sawText = true
        parts.push({ type: 'text-delta', id: this.openText, delta: text })
        return
      }
      case 'tool_call': {
        const id = e.call_id
        if (!id) return
        // If the stream also reports a web call, drop recovered duplicates by id, or the same
        // tool and target under another id.
        const web = webKey(e)
        if (recovered) {
          if (this.streamedWeb.has(id) || (web && this.streamedWeb.has(web))) return
        } else if (web) {
          this.streamedWeb.add(id)
          this.streamedWeb.add(web)
        }
        const status = e.status ?? 'running'
        let call = this.openTools.get(id)
        if (!call) {
          if (status !== 'running' && this.seen.has(id)) return
          this.closeBlocks(parts)
          const projected = projectToolCall(e.name ?? 'unknown', e.args)
          call = { toolName: projected.toolName, dynamic: projected.dynamic }
          this.openTools.set(id, call)
          this.seen.add(id)
          parts.push({
            type: 'tool-call',
            toolCallId: id,
            toolName: projected.toolName,
            input: JSON.stringify(this.relative(projected.input)),
            providerExecuted: true,
            ...(projected.dynamic ? { dynamic: true } : {}),
            ...(projected.toolName !== projected.nativeName
              ? { nativeName: projected.nativeName }
              : {}),
          })
        }
        if (status === 'running') return
        this.openTools.delete(id)
        const { output, error } = projectToolResult(call.toolName, status, e.result)
        parts.push({
          type: 'tool-result',
          toolCallId: id,
          toolName: call.toolName,
          result: output as NonNullable<JSONValue>,
          ...(error !== undefined ? { isError: true } : {}),
          ...(call.dynamic ? { dynamic: true } : {}),
        })
        return
      }
      case 'usage': {
        this.closeBlocks(parts)
        this.stepUsage = e.usage ?? {}
        return
      }
    }
  }

  private finish(parts: HarnessV1StreamPart[], r: CursorSdkResult) {
    this.result = r
    this.agentId = r.agentId ?? this.agentId
    this.closeTools(parts, 'unfinished')
    if (!this.sawText && r.result) {
      parts.push({ type: 'text-start', id: 'text-result' })
      parts.push({ type: 'text-delta', id: 'text-result', delta: r.result })
      parts.push({ type: 'text-end', id: 'text-result' })
    }
    this.closeBlocks(parts)
    this.closeStep(parts, r.usage)
    const status = r.status ?? 'unknown'
    if (status !== 'finished' && status !== 'cancelled') {
      parts.push({
        type: 'error',
        error: new Error(r.error?.message || `The Cursor SDK run ended with status ${status}`),
      })
    }
    this.finished = true
    parts.push({
      type: 'finish',
      finishReason: { unified: FINISH[status] ?? 'other', raw: status },
      totalUsage: toUsage(r.usage),
      harnessMetadata: {
        cursorSdk: {
          ...(r.agentId ? { agentId: r.agentId } : {}),
          ...(r.runId ? { runId: r.runId } : {}),
          ...(r.requestId ? { requestId: r.requestId } : {}),
          ...(r.model ? { model: r.model } : {}),
          ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
          ...(r.usage ? { usage: { ...r.usage } } : {}),
          ...(this.unreportedTools.length ? { unreportedTools: [...this.unreportedTools] } : {}),
        },
      },
    })
  }

  private fail(parts: HarnessV1StreamPart[], message: string, raw: string) {
    this.closeTools(parts, 'interrupted')
    this.closeBlocks(parts)
    this.closeStep(parts)
    parts.push({ type: 'error', error: new Error(message) })
    this.finished = true
    parts.push({
      type: 'finish',
      finishReason: { unified: 'error', raw },
      totalUsage: toUsage(undefined),
      harnessMetadata: this.unrecovered(),
    })
  }

  /** The turn's one step, with the `usage` event's counts, else the result's when it has them. */
  private closeStep(parts: HarnessV1StreamPart[], resultUsage?: CursorSdkUsage) {
    const usage = this.stepUsage ?? resultUsage
    // A turn cut short has content and no usage yet: its step still has to close.
    if (!usage && !this.stepHasContent && !parts.some(isContent)) return
    parts.push({
      type: 'finish-step',
      finishReason: usage
        ? { unified: 'stop', raw: this.stepUsage ? 'turn-ended' : 'result' }
        : { unified: 'other', raw: 'interrupted' },
      usage: toUsage(usage),
    })
    this.stepUsage = undefined
    this.stepHasContent = false
  }

  /** A turn that ended before its result never had its web calls recovered. */
  private unrecovered() {
    return { cursorSdk: { unreportedTools: Object.values(CURSOR_SDK_RECOVERED_TOOLS) } }
  }
}
