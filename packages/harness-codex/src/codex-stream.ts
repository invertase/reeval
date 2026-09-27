import { posix } from 'node:path'
import type { HarnessV1StreamPart } from '@ai-sdk/harness'

type Usage = Extract<HarnessV1StreamPart, { type: 'finish' }>['totalUsage']

/** A turn's counts, as `turn.completed` reports them: `input_tokens` includes the cached ones. */
export type CodexUsage = {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
}

export type CodexItem = {
  id?: string
  type?: string
  text?: string
  command?: string
  aggregated_output?: string
  exit_code?: number | null
  status?: string
  changes?: { path?: string; kind?: string }[]
  server?: string
  tool?: string
  arguments?: unknown
  result?: { content?: unknown; structured_content?: unknown } | null
  error?: { message?: string } | null
  query?: string
  action?: { type?: string; query?: string; url?: string; pattern?: string }
  message?: string
}

export type CodexEvent = {
  type?: string
  thread_id?: string
  item?: CodexItem
  usage?: CodexUsage
  error?: { message?: string }
  message?: string
}

/** Codex's counts in the AI SDK's shape. Its `output_tokens` includes the reasoning ones. */
export function toUsage(usage: CodexUsage | undefined): Usage {
  const total = usage?.input_tokens
  const cacheRead = usage?.cached_input_tokens
  const cacheWrite = usage?.cache_write_input_tokens
  const output = usage?.output_tokens
  const reasoning = usage?.reasoning_output_tokens
  return {
    inputTokens: {
      total,
      noCache:
        total !== undefined ? Math.max(total - (cacheRead ?? 0) - (cacheWrite ?? 0), 0) : undefined,
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

/** A `file_change` path's kind as the adapter's tool name. */
const CHANGE_TOOLS: Record<string, string> = { add: 'write', update: 'edit', delete: 'delete' }

/**
 * Turns one `codex exec --json` process's NDJSON into harness stream parts. Codex reports a turn,
 * not its model calls: `turn.completed` is one `finish-step` with the turn's tokens and the
 * `finish`. A top-level `error` before it is a call Codex retries ("Reconnecting... n/5"), so it's
 * a failed step, not the turn's end, unless `turn.failed` follows it: Codex announces the failure
 * that ends the turn with an `error` too, and that call wasn't retried.
 */
export class CodexStreamTranslator {
  threadId: string | undefined
  private started = false
  private finished = false
  private readonly workDir: string
  /** Blocks by item id: their start part went out, and what they've said so far. */
  private readonly blocks = new Map<string, { type: 'text' | 'reasoning'; text: string }>()
  /** Tool calls by id whose call went out, so a result isn't sent without one. */
  private readonly calls = new Set<string>()
  /** The last top-level `error`, a retry unless the next event is `turn.failed`. */
  private pendingError: string | undefined

  constructor(options: { workDir: string }) {
    this.workDir = options.workDir
  }

  /** Parts for one stdout line. Lines that aren't JSON events are passed through as raw. */
  push(line: string): HarnessV1StreamPart[] {
    const trimmed = line.trim()
    if (!trimmed) return []
    let event: CodexEvent
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

  /** Closes the turn when the process ends: `turn.completed` or `turn.failed` did, or it died first. */
  end(options: { exitCode: number; stderr?: string; aborted?: boolean }): HarnessV1StreamPart[] {
    if (this.finished) return []
    const parts: HarnessV1StreamPart[] = []
    this.start(parts)
    this.flushError(parts)
    this.closeBlocks(parts)
    if (!options.aborted) {
      const detail = options.stderr?.trim()
      parts.push({
        type: 'error',
        error: new Error(
          `codex exited with code ${options.exitCode} before ending the turn${detail ? `: ${detail}` : ''}`,
        ),
      })
    }
    this.finish(parts, options.aborted ? 'aborted' : `exit ${options.exitCode}`)
    return parts
  }

  private translate(e: CodexEvent, parts: HarnessV1StreamPart[]) {
    if (e.type === 'turn.failed') this.pendingError = undefined
    else this.flushError(parts)
    switch (e.type) {
      case 'thread.started':
        this.threadId = e.thread_id ?? this.threadId
        return
      case 'turn.started':
        this.start(parts)
        return
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        if (e.item) this.item(e.type, e.item, parts)
        return
      case 'error':
        this.start(parts)
        this.pendingError = e.message ?? 'error'
        return
      case 'turn.completed':
        this.start(parts)
        this.closeBlocks(parts)
        parts.push({
          type: 'finish-step',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: toUsage(e.usage),
        })
        this.finish(parts, 'stop', e.usage)
        return
      case 'turn.failed':
        this.start(parts)
        this.closeBlocks(parts)
        parts.push({
          type: 'error',
          error: new Error(e.error?.message || 'codex reported a failed turn'),
        })
        this.finish(parts, 'error')
        return
    }
  }

  private item(kind: string, item: CodexItem, parts: HarnessV1StreamPart[]) {
    const id = item.id ?? `item-${this.calls.size + this.blocks.size}`
    const completed = kind === 'item.completed'
    switch (item.type) {
      case 'agent_message':
      case 'reasoning':
        this.block(id, item.type === 'agent_message' ? 'text' : 'reasoning', item.text, parts)
        if (completed) this.closeBlock(id, parts)
        return
      case 'command_execution':
        this.call(parts, id, 'bash', { command: item.command ?? '' })
        if (completed) {
          this.result(parts, id, 'bash', item.aggregated_output ?? '', item.status === 'failed')
        }
        return
      case 'file_change':
        for (const [i, change] of (item.changes ?? []).entries()) {
          const tool = CHANGE_TOOLS[change.kind ?? ''] ?? 'edit'
          const callId = `${id}:${i}`
          this.call(parts, callId, tool, { path: this.relative(change.path ?? '') })
          if (completed) {
            this.result(parts, callId, tool, { kind: change.kind }, item.status === 'failed')
          }
        }
        return
      case 'mcp_tool_call': {
        const tool = `mcp__${item.server ?? 'unknown'}__${item.tool ?? 'unknown'}`
        this.call(parts, id, tool, item.arguments ?? {})
        if (completed) {
          const failed = item.status === 'failed' || Boolean(item.error)
          const output = failed
            ? (item.error?.message ?? 'the MCP tool call failed')
            : (item.result?.structured_content ?? item.result?.content ?? null)
          this.result(parts, id, tool, output, failed)
        }
        return
      }
      // One item for each of the model's web actions, known once it completes: a search, or a page
      // it opened or searched within, which is a fetch. Both run on OpenAI's side.
      case 'web_search': {
        if (!completed) return
        const { type, url, query, pattern } = item.action ?? {}
        if ((type === 'open_page' || type === 'find_in_page') && url) {
          this.call(parts, id, 'webFetch', { url, ...(pattern ? { pattern } : {}) })
          this.result(parts, id, 'webFetch', {}, false)
        } else {
          this.call(parts, id, 'webSearch', { query: query || item.query || '' })
          this.result(parts, id, 'webSearch', {}, false)
        }
        return
      }
    }
  }

  private flushError(parts: HarnessV1StreamPart[]) {
    if (this.pendingError === undefined) return
    parts.push({
      type: 'finish-step',
      finishReason: { unified: 'error', raw: this.pendingError },
      usage: toUsage(undefined),
    })
    this.pendingError = undefined
  }

  private relative(path: string) {
    const rel = posix.relative(this.workDir, path)
    return path.startsWith('/') && !rel.startsWith('..') ? rel : path
  }

  private block(
    id: string,
    type: 'text' | 'reasoning',
    text: string | undefined,
    parts: HarnessV1StreamPart[],
  ) {
    if (!text) return
    let block = this.blocks.get(id)
    if (!block) {
      block = { type, text: '' }
      this.blocks.set(id, block)
      parts.push({ type: `${type}-start`, id })
    }
    if (text.length > block.text.length && text.startsWith(block.text)) {
      parts.push({ type: `${type}-delta`, id, delta: text.slice(block.text.length) })
      block.text = text
    }
  }

  private closeBlock(id: string, parts: HarnessV1StreamPart[]) {
    const block = this.blocks.get(id)
    if (!block) return
    this.blocks.delete(id)
    parts.push({ type: `${block.type}-end`, id })
  }

  private closeBlocks(parts: HarnessV1StreamPart[]) {
    for (const id of [...this.blocks.keys()]) this.closeBlock(id, parts)
  }

  private call(parts: HarnessV1StreamPart[], id: string, toolName: string, input: unknown) {
    if (this.calls.has(id)) return
    this.calls.add(id)
    parts.push({
      type: 'tool-call',
      toolCallId: id,
      toolName,
      input: JSON.stringify(input),
      providerExecuted: true,
    })
  }

  private result(
    parts: HarnessV1StreamPart[],
    id: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ) {
    parts.push({
      type: 'tool-result',
      toolCallId: id,
      toolName,
      result: result as never,
      ...(isError ? { isError: true } : {}),
    })
  }

  private start(parts: HarnessV1StreamPart[]) {
    if (this.started) return
    this.started = true
    parts.push({ type: 'stream-start' })
  }

  private finish(parts: HarnessV1StreamPart[], raw: string, usage?: CodexUsage) {
    this.finished = true
    parts.push({
      type: 'finish',
      finishReason: {
        unified: raw === 'stop' ? 'stop' : raw === 'aborted' ? 'other' : 'error',
        raw,
      },
      totalUsage: toUsage(usage),
    })
  }
}
