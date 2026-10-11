import type { HarnessV1StreamPart } from '@ai-sdk/harness'

type Usage = Extract<HarnessV1StreamPart, { type: 'finish' }>['totalUsage']
type FinishReason = Extract<HarnessV1StreamPart, { type: 'finish-step' }>['finishReason']

/** One model call's counts, as pi's `message_end` reports them (it also has a USD `cost`). */
export type PiUsage = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

type PiContent = { type?: string; text?: string }
type PiMessage = {
  role?: string
  model?: string
  usage?: PiUsage
  stopReason?: string
  errorMessage?: string
  content?: PiContent[] | string
}
export type PiEvent = {
  type?: string
  id?: string
  message?: PiMessage
  assistantMessageEvent?: {
    type?: string
    contentIndex?: number
    delta?: string
    toolCall?: { id?: string; name?: string; arguments?: unknown }
  }
  toolCallId?: string
  toolName?: string
  result?: { content?: PiContent[]; details?: unknown }
  isError?: boolean
}

/** pi's counts in the AI SDK's shape. `input` is uncached; pi's is too. */
export function toUsage(usage: PiUsage | undefined): Usage {
  const noCache = usage?.input
  const cacheRead = usage?.cacheRead
  const cacheWrite = usage?.cacheWrite
  const output = usage?.output
  const reasoning = usage?.reasoning
  return {
    inputTokens: {
      total: noCache !== undefined ? noCache + (cacheRead ?? 0) + (cacheWrite ?? 0) : undefined,
      noCache,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: output,
      text: output !== undefined && reasoning !== undefined ? output - reasoning : undefined,
      reasoning,
    },
  }
}

const add = (a: PiUsage | undefined, b: PiUsage): PiUsage => ({
  input: (a?.input ?? 0) + (b.input ?? 0),
  output: (a?.output ?? 0) + (b.output ?? 0),
  cacheRead: (a?.cacheRead ?? 0) + (b.cacheRead ?? 0),
  cacheWrite: (a?.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
  reasoning: (a?.reasoning ?? 0) + (b.reasoning ?? 0),
})

/** pi's stop reasons for a call that didn't fail; `error` is an error part instead. */
const UNIFIED: Record<string, FinishReason['unified']> = {
  stop: 'stop',
  toolUse: 'tool-calls',
  length: 'length',
  aborted: 'other',
}

const text = (content: PiContent[] | undefined) =>
  (content ?? []).flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('')

/**
 * pi names an MCP tool `mcp__<server>__<tool>` with every `-` made `_`. This puts
 * the server's configured name back when no other server sanitizes to the same name. The tool
 * part stays as pi named it: the adapter doesn't know the server's tool names, and pi shortens a
 * colliding or over-64-character name with a hash.
 */
export function configuredMcpToolName(name: string, servers: readonly string[]): string {
  const sanitize = (server: string) => server.replaceAll('-', '_')
  const owner = servers
    .filter((s) => s.includes('-') && name.startsWith(`mcp__${sanitize(s)}__`))
    .sort((a, b) => b.length - a.length)[0]
  if (!owner || servers.some((s) => s !== owner && sanitize(s) === sanitize(owner))) return name
  return `mcp__${owner}__${name.slice(`mcp__${sanitize(owner)}__`.length)}`
}

/**
 * Turns one `pi --mode json` process's NDJSON into harness stream parts. Each assistant message
 * is one model call: its `message_end` is a `finish-step` with that call's usage, and the turn's
 * `finish` has their sum. A call pi reports as failed (`stopReason: 'error'`) is an error part.
 */
export class PiStreamTranslator {
  sessionId: string | undefined
  /** The configured MCP server names, which tool names are mapped back to. */
  private readonly mcpServers: readonly string[]
  constructor(options: { mcpServers?: readonly string[] } = {}) {
    this.mcpServers = options.mcpServers ?? []
  }
  private started = false
  private finished = false
  /** The block a `*_start` opened; its start part goes out with its first non-empty delta. */
  private open: { id: string; type: 'text' | 'reasoning'; emitted: boolean } | undefined
  private total: PiUsage | undefined
  private failed = false

  /** Parts for one stdout line. Lines that aren't JSON events are passed through as raw. */
  push(line: string): HarnessV1StreamPart[] {
    const trimmed = line.trim()
    if (!trimmed) return []
    let event: PiEvent
    try {
      event = JSON.parse(trimmed)
    } catch {
      return [{ type: 'raw', rawValue: { unparsed: trimmed } }]
    }
    const parts: HarnessV1StreamPart[] = []
    if (!this.finished) this.translate(event, parts)
    parts.push({ type: 'raw', rawValue: event })
    return parts
  }

  /** Closes the turn when the process ends: its `agent_end` finished it, or it died first. */
  end(options: { exitCode: number; stderr?: string; aborted?: boolean }): HarnessV1StreamPart[] {
    if (this.finished) return []
    const parts: HarnessV1StreamPart[] = []
    this.start(parts)
    this.close(parts)
    if (!options.aborted) {
      const detail = options.stderr?.trim()
      parts.push({
        type: 'error',
        error: new Error(
          `pi exited with code ${options.exitCode} before ending the turn${detail ? `: ${detail}` : ''}`,
        ),
      })
    }
    this.finish(parts, options.aborted ? 'aborted' : `exit ${options.exitCode}`)
    return parts
  }

  private translate(e: PiEvent, parts: HarnessV1StreamPart[]) {
    if (e.type === 'session') {
      this.sessionId = e.id ?? this.sessionId
      return
    }
    const m = e.message
    if (e.type === 'message_start' && m?.role === 'assistant') {
      this.start(parts, m.model)
      return
    }
    if (e.type === 'message_update') {
      this.update(e, parts)
      return
    }
    if (e.type === 'message_end' && m?.role === 'assistant') {
      this.close(parts)
      if (m.stopReason === 'error') {
        this.failed = true
        parts.push({
          type: 'error',
          error: new Error(m.errorMessage || 'pi reported a failed model call'),
        })
        return
      }
      if (m.usage) this.total = add(this.total, m.usage)
      parts.push({
        type: 'finish-step',
        finishReason: {
          unified: UNIFIED[m.stopReason ?? 'stop'] ?? 'stop',
          raw: m.stopReason ?? 'stop',
        },
        usage: toUsage(m.usage),
      })
      return
    }
    if (e.type === 'tool_execution_end' && e.toolCallId) {
      const output = text(e.result?.content)
      parts.push({
        type: 'tool-result',
        toolCallId: e.toolCallId,
        toolName: this.toolName(e.toolName),
        result:
          e.result?.details !== undefined ? { output, details: e.result.details as never } : output,
        ...(e.isError ? { isError: true } : {}),
      })
      return
    }
    if (e.type === 'agent_end') {
      this.start(parts)
      this.close(parts)
      this.finish(parts, this.failed ? 'error' : 'stop')
    }
  }

  private update(e: PiEvent, parts: HarnessV1StreamPart[]) {
    const u = e.assistantMessageEvent
    if (!u?.type) return
    const id = `${u.type.startsWith('thinking') ? 'reasoning' : 'text'}-${u.contentIndex ?? 0}`
    if (u.type === 'text_start' || u.type === 'thinking_start') {
      this.close(parts)
      const type = u.type === 'text_start' ? 'text' : 'reasoning'
      this.open = { id, type, emitted: false }
    } else if ((u.type === 'text_delta' || u.type === 'thinking_delta') && u.delta) {
      if (!this.open) return
      if (!this.open.emitted) {
        parts.push({ type: `${this.open.type}-start`, id: this.open.id })
        this.open.emitted = true
      }
      parts.push({ type: `${this.open.type}-delta`, id: this.open.id, delta: u.delta })
    } else if (u.type === 'text_end' || u.type === 'thinking_end') {
      this.close(parts)
    } else if (u.type === 'toolcall_end' && u.toolCall?.id) {
      this.close(parts)
      parts.push({
        type: 'tool-call',
        toolCallId: u.toolCall.id,
        toolName: this.toolName(u.toolCall.name),
        input: JSON.stringify(u.toolCall.arguments ?? {}),
        providerExecuted: true,
      })
    }
  }

  private toolName(name: string | undefined) {
    return name === undefined ? 'unknown' : configuredMcpToolName(name, this.mcpServers)
  }

  private start(parts: HarnessV1StreamPart[], modelId?: string) {
    if (this.started) return
    this.started = true
    parts.push({ type: 'stream-start', ...(modelId ? { modelId } : {}) })
  }

  private close(parts: HarnessV1StreamPart[]) {
    if (this.open?.emitted) parts.push({ type: `${this.open.type}-end`, id: this.open.id })
    this.open = undefined
  }

  private finish(parts: HarnessV1StreamPart[], raw: string) {
    this.finished = true
    parts.push({
      type: 'finish',
      finishReason: {
        unified: raw === 'stop' ? 'stop' : raw === 'aborted' ? 'other' : 'error',
        raw,
      },
      totalUsage: toUsage(this.total),
    })
  }
}
