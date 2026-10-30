import { SANDBOX_ROOT, WORKSPACE_DIR } from '@reeval/sandbox-docker'
import { isObjectLike } from '../object.ts'
import type { FileEditEvent, TokenUsage, TranscriptEvent } from '../types.ts'
import type { ReasoningDelivery } from './agents.ts'

/** One stream part and when it arrived, in ms since the turn started. */
export type StampedPart = { ms: number; part: { type: string; [key: string]: unknown } }

type Pending = { ms: number; part: StampedPart['part'] }
/**
 * `at` places a call recovered after the turn where it happened, not where it was reported;
 * `recovered` times it by the backend's clock alone, since its result arrives after the turn.
 */
type Timing = { start?: number; end?: number; at?: number; recovered?: boolean }

/** Shell-like tools at or above this duration get `stalled: true` on their transcript event. */
export const STALL_TOOL_MS = 120_000

const SHELL_TOOLS = new Set([
  'bash',
  'shell',
  'Shell',
  'run_terminal_cmd',
  'execute_command',
  'terminal',
])

const str = (value: unknown) => (typeof value === 'string' ? value : '')

/** Wall time until the result part arrived; Cursor can report `completed_at_ms` before the shell returns. */
function toolDurationMs(start: number, call: Pending, endMs: number, t?: Timing): number {
  const wall = endMs - start
  if (t?.end === undefined) return endMs - call.ms
  if (t.recovered) return t.end - start
  return Math.max(t.end - start, wall)
}

function stallFlags(tool: string, durationMs: number | null): { stalled?: boolean } {
  if (durationMs === null || durationMs < STALL_TOOL_MS) return {}
  if (SHELL_TOOLS.has(tool) || tool === 'edit') return { stalled: true }
  return {}
}
const record = (value: unknown): Record<string, unknown> => (isObjectLike(value) ? value : {})

/** The harness's synthetic "fileChange" twin of every edit, which always says "modify". */
const isFileChangeEcho = (part: StampedPart['part']) =>
  part.toolName === 'fileChange' || str(part.toolCallId).startsWith('harness-file-change-')

function lines(text: string): string[] {
  if (!text) return []
  const all = text.split('\n')
  if (all.at(-1) === '') all.pop()
  return all
}

/** Lines only in `before` (removed) and only in `after` (added), as multisets. */
function lineDelta(before: string, after: string): { added: number; removed: number } {
  const counts = new Map<string, number>()
  for (const line of lines(before)) counts.set(line, (counts.get(line) ?? 0) + 1)
  let added = 0
  for (const line of lines(after)) {
    const n = counts.get(line) ?? 0
    if (n > 0) counts.set(line, n - 1)
    else added++
  }
  const removed = [...counts.values()].reduce((a, b) => a + b, 0)
  return { added, removed }
}

const WORKSPACE = `${SANDBOX_ROOT}/${WORKSPACE_DIR}/`

/** A path under the workspace, relative to it, as Cursor reports them. */
const inWorkspace = (path: string) =>
  path.startsWith(WORKSPACE) ? path.slice(WORKSPACE.length) : path

/** Cursor's and OpenCode's edit tools take `path`, Claude Code's `file_path`. */
const editPath = (input: Record<string, unknown>) => str(input.path) || str(input.file_path)

/**
 * Cursor reports `referenceCount`; Claude Code lists `results`, where each search is
 * `{ content: [{ title, url }] }` and plain strings are commentary.
 */
function searchReferences(output: unknown): number | null {
  const { referenceCount, references, results } = record(output)
  if (typeof referenceCount === 'number') return referenceCount
  if (Array.isArray(references)) return references.length
  if (!Array.isArray(results)) return null
  return results.reduce((n: number, r) => {
    const links = record(r).content
    return n + (Array.isArray(links) ? links.length : 0)
  }, 0)
}

/**
 * Claude Code's bridge sends errors as `{ message }` objects; Cursor's as strings or Errors; ACP
 * harnesses (OpenCode) the tool's `rawOutput`, `{ metadata, error }`. Any other object is kept as JSON.
 */
export const errorText = (error: unknown) =>
  str(error) || str(record(error).message) || str(record(error).error) || jsonText(error)

function jsonText(value: unknown): string {
  if (typeof value !== 'object' || value === null) return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Lines added and removed across unified-diff hunks, each `{ lines: ['+x', '-y', ' z'] }`. */
function hunkDelta(hunks: unknown[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    const lines = record(hunk).lines
    for (const line of Array.isArray(lines) ? lines : []) {
      if (str(line).startsWith('+')) added++
      else if (str(line).startsWith('-')) removed++
    }
  }
  return { added, removed }
}

/** Claude Code's Write (`type`, `content`) or Edit (`oldString`, `newString`) result. */
function claudeEdit(toolCallId: string, output: Record<string, unknown>): FileEditEvent {
  const { originalFile, structuredPatch, content, oldString, newString } = output
  const created = output.type === 'create' || (output.type === undefined && originalFile === null)
  const counts =
    Array.isArray(structuredPatch) && structuredPatch.length > 0
      ? hunkDelta(structuredPatch)
      : created
        ? { added: lines(str(content ?? newString)).length, removed: 0 }
        : typeof originalFile === 'string' && typeof content === 'string'
          ? lineDelta(originalFile, content)
          : typeof oldString === 'string' && typeof newString === 'string'
            ? lineDelta(oldString, newString)
            : { added: null, removed: null }
  return {
    type: 'file-edit',
    toolCallId,
    path: str(output.filePath),
    kind: created ? 'create' : 'modify',
    ...counts,
  }
}

function fileEdits(
  toolCallId: string,
  output: unknown,
  tool: 'edit' | 'write' | 'delete',
  input: Record<string, unknown>,
): FileEditEvent[] {
  if (tool === 'delete') {
    return [
      {
        type: 'file-edit',
        toolCallId,
        path: editPath(input),
        kind: 'delete',
        added: 0,
        removed: null,
      },
    ]
  }
  const result = record(output)
  if (typeof result.filePath === 'string') return [claudeEdit(toolCallId, result)]
  // pi's edit reports a unified `patch` in its `details`.
  const patch = str(record(result.details).patch)
  if (patch) {
    // Only the `---` and `+++` before the first `@@` are headers: in a hunk, `--- x` removes `-- x`.
    const all = lines(patch)
    const hunks = all.findIndex((l) => l.startsWith('@@'))
    const body = hunks < 0 ? [] : all.slice(hunks + 1)
    return [
      {
        type: 'file-edit',
        toolCallId,
        path: editPath(input),
        kind: 'modify',
        added: body.filter((l) => l.startsWith('+')).length,
        removed: body.filter((l) => l.startsWith('-')).length,
      },
    ]
  }
  // OpenCode's edit lists the `files` it changed, with counts; its write only says, in words,
  // whether it created the file.
  const files = record(result.metadata).files
  if (Array.isArray(files) && files.length > 0) {
    return files.map((f) => {
      const file = record(f)
      return {
        type: 'file-edit',
        toolCallId,
        path: inWorkspace(str(file.file) || editPath(input)),
        kind: file.status === 'added' ? 'create' : file.status === 'deleted' ? 'delete' : 'modify',
        added: typeof file.additions === 'number' ? file.additions : null,
        removed: typeof file.deletions === 'number' ? file.deletions : null,
      }
    })
  }
  const said = str(result.output)
  if (/^(Created|Wrote) file successfully/.test(said)) {
    const created = said.startsWith('Created')
    return [
      {
        type: 'file-edit',
        toolCallId,
        path: inWorkspace(editPath(input)),
        kind: created ? 'create' : 'modify',
        added: created ? lines(str(input.content)).length : null,
        removed: created ? 0 : null,
      },
    ]
  }
  // Codex's file changes say whether the patch added or updated the file, not by how many lines.
  if (result.kind === 'add' || result.kind === 'update') {
    return [
      {
        type: 'file-edit',
        toolCallId,
        path: editPath(input),
        kind: result.kind === 'add' ? 'create' : 'modify',
        added: null,
        removed: null,
      },
    ]
  }
  // Cursor reports counts and a unified diff, whose old side is /dev/null for a new file.
  if (typeof result.linesAdded === 'number') {
    return [
      {
        type: 'file-edit',
        toolCallId,
        path: editPath(input),
        kind: str(result.diffString).startsWith('--- /dev/null') ? 'create' : 'modify',
        added: result.linesAdded,
        removed: typeof result.linesRemoved === 'number' ? result.linesRemoved : null,
      },
    ]
  }
  // A whole-file write whose result doesn't say whether the file existed (Antigravity's, fx's,
  // Goose's, Grok Build's and pi's, for example): the content, when the input has it, is every
  // line written.
  if (tool === 'write') {
    return [
      {
        type: 'file-edit',
        toolCallId,
        path: editPath(input),
        kind: 'write',
        added: typeof input.content === 'string' ? lines(input.content).length : null,
        removed: null,
      },
    ]
  }
  return [
    {
      type: 'file-edit',
      toolCallId,
      path: editPath(input),
      kind: 'modify',
      added: null,
      removed: null,
    },
  ]
}

/**
 * The tool's name. Cursor reports an MCP call as `mcp`, with the server and tool in its input;
 * those are named `mcp__<server>__<tool>`, as Claude Code names its own.
 */
function toolName(part: StampedPart['part']): string {
  const input = record(part.input)
  if (typeof input.providerIdentifier === 'string' && typeof input.toolName === 'string') {
    return `mcp__${input.providerIdentifier}__${input.toolName}`
  }
  return str(part.toolName)
}

/** The tool's input: a Cursor MCP call's own `args`, without the wrapper naming its server and tool. */
function toolInput(part: StampedPart['part']): unknown {
  const input = record(part.input)
  if (typeof input.providerIdentifier === 'string' && typeof input.toolName === 'string') {
    return input.args ?? {}
  }
  return part.input
}

/** Claude Code's native tool names as its adapter's common ones, for a subagent's calls. */
const CLAUDE_COMMON_NAMES: Readonly<Record<string, string>> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  Bash: 'bash',
  Glob: 'glob',
  Grep: 'grep',
  WebSearch: 'webSearch',
}

/** A tool result's content as text: Claude's is a string or a list of `{ type: 'text', text }`. */
const contentText = (content: unknown): string =>
  Array.isArray(content)
    ? content.map((c) => str(record(c).text)).join('')
    : typeof content === 'string'
      ? content
      : jsonText(content)

/**
 * A Claude Code subagent's edit as Claude's own Edit or Write result, which `claudeEdit` reads:
 * the bridge passes a subagent's messages on as raw SDK messages, whose result is only text.
 */
function subagentEditOutput(tool: string, input: Record<string, unknown>, said: string): unknown {
  const filePath = inWorkspace(editPath(input))
  if (tool === 'edit') {
    return { filePath, oldString: input.old_string, newString: input.new_string }
  }
  return {
    type: /created successfully/i.test(said) ? 'create' : 'update',
    filePath,
    content: input.content,
  }
}

/**
 * The tool calls and results in a Claude Code subagent's SDK message (`parent_tool_use_id` set),
 * which the bridge passes on only as a `raw` part, as the stream parts its own calls arrive as.
 */
function subagentParts(raw: Record<string, unknown>): Array<StampedPart['part']> {
  const parent = raw.parent_tool_use_id
  if (typeof parent !== 'string' || (raw.type !== 'assistant' && raw.type !== 'user')) return []
  const content = record(raw.message).content
  if (!Array.isArray(content)) return []
  const structured = record(raw.tool_use_result)
  return content.flatMap((b): Array<StampedPart['part']> => {
    const block = record(b)
    if (raw.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
      const name = str(block.name)
      return [
        {
          type: 'tool-call',
          toolCallId: block.id,
          toolName: CLAUDE_COMMON_NAMES[name] ?? name,
          input: block.input ?? {},
          subagent: parent,
        },
      ]
    }
    if (raw.type === 'user' && block.type === 'tool_result') {
      const said = contentText(block.content)
      const id = str(block.tool_use_id)
      return block.is_error === true
        ? [{ type: 'tool-error', toolCallId: id, error: said }]
        : [{ type: 'tool-result', toolCallId: id, output: said, structured }]
    }
    return []
  })
}

/**
 * Turns an AI SDK harness stream into reeval transcript events: text and reasoning blocks joined,
 * each tool call merged with its result, edits normalized to `file-edit`, web tools given their
 * query or URL, and the harness's duplicate `fileChange` events dropped. Cursor's tool durations
 * come from its runner's own `tool_call` events, because tool results are only flushed at the
 * end of a step.
 */
export function normalizeStream(parts: StampedPart[], startedAt: number): TranscriptEvent[] {
  const timing = new Map<string, Timing>()
  for (const { ms, part } of parts) {
    if (part.type !== 'raw') continue
    const raw = record(part.rawValue)
    const event = raw.type === 'event' ? record(raw.event) : {}
    const id = event.type === 'tool_call' ? str(event.call_id) : ''
    if (!id) continue
    const t = timing.get(id) ?? {}
    // A call recovered after the turn carries the backend's own times, as epoch ms.
    const started =
      typeof event.started_at_ms === 'number' ? event.started_at_ms - startedAt : undefined
    const ended =
      typeof event.completed_at_ms === 'number' ? event.completed_at_ms - startedAt : undefined
    if (started !== undefined) t.at = t.start = started
    else if (event.status === 'running' && t.start === undefined) t.start = ms
    if (ended !== undefined) {
      t.end = ended
      if (raw.recovered !== undefined && t.start !== undefined) t.recovered = true
    } else if (event.status === 'completed' || event.status === 'error') t.end = ms
    timing.set(id, t)
  }

  const out: Array<{ at: number; event: TranscriptEvent }> = []
  const stamp = (at: number) => ({ ts: new Date(startedAt + at).toISOString(), atMs: at })
  const blocks = new Map<string, { type: 'text' | 'reasoning'; ms: number; text: string }>()
  const pending = new Map<string, Pending>()

  const toolDone = (id: string, reported: Pending, end: StampedPart, failed: boolean) => {
    let call = reported
    const t = timing.get(id)
    const start = t?.start ?? call.ms
    const durationMs = toolDurationMs(start, call, end.ms, t)
    call = t?.at === undefined ? call : { ...call, ms: t.at }
    const input = record(call.part.input)
    const name = toolName(call.part)
    const raw = failed ? errorText(end.part.error) : end.part.output
    const subagent = str(call.part.subagent)
    const structured = record(end.part.structured)
    // Antigravity runs commands in a PTY, so their output has CRLF line endings.
    const output =
      subagent && (name === 'edit' || name === 'write') && !failed
        ? typeof structured.filePath === 'string'
          ? { ...structured, filePath: inWorkspace(structured.filePath) }
          : subagentEditOutput(name, input, str(raw))
        : name === 'bash' && typeof raw === 'string'
          ? raw.replace(/\r\n/g, '\n')
          : raw
    const base = {
      ...stamp(call.ms),
      durationMs,
      ...stallFlags(name, durationMs),
      ...(subagent ? { subagent } : {}),
    }
    if ((name === 'edit' || name === 'write' || name === 'delete') && !failed) {
      for (const edit of fileEdits(id, output, name, input)) {
        out.push({ at: call.ms, event: { ...base, ...edit, ...stallFlags(name, durationMs) } })
      }
      return
    }
    if (name === 'webSearch') {
      out.push({
        at: call.ms,
        event: {
          ...base,
          type: 'web-search',
          toolCallId: id,
          query: str(input.searchTerm) || str(input.query),
          references: failed ? null : searchReferences(output),
          ok: !failed,
        },
      })
      return
    }
    if (name === 'webFetch' || name === 'WebFetch') {
      const result = record(output)
      const status = typeof result.code === 'number' ? result.code : undefined
      out.push({
        at: call.ms,
        event: {
          ...base,
          type: 'web-fetch',
          toolCallId: id,
          url: str(input.url),
          ok:
            !failed &&
            result.success !== false &&
            (status === undefined || (status >= 200 && status < 400)),
        },
      })
      return
    }
    out.push({
      at: call.ms,
      event: {
        ...base,
        type: 'tool',
        toolCallId: id,
        tool: name,
        input: toolInput(call.part),
        output,
        ok: !failed,
      },
    })
  }

  for (const stamped of parts) {
    const { ms, part } = stamped
    switch (part.type) {
      case 'raw':
        for (const sub of subagentParts(record(part.rawValue))) {
          const id = str(sub.toolCallId)
          if (sub.type === 'tool-call') {
            pending.set(id, { ms, part: sub })
            continue
          }
          const call = pending.get(id)
          if (!call) continue
          pending.delete(id)
          toolDone(id, call, { ms, part: sub }, sub.type === 'tool-error')
        }
        break
      case 'text-start':
      case 'reasoning-start':
        blocks.set(str(part.id), {
          type: part.type === 'text-start' ? 'text' : 'reasoning',
          ms,
          text: '',
        })
        break
      case 'text-delta':
      case 'reasoning-delta': {
        const block = blocks.get(str(part.id))
        if (block) block.text += str(part.text ?? part.delta)
        break
      }
      case 'text-end':
      case 'reasoning-end': {
        const block = blocks.get(str(part.id))
        blocks.delete(str(part.id))
        if (block?.text.trim()) {
          out.push({
            at: block.ms,
            event: {
              ...stamp(block.ms),
              type: block.type,
              text: block.text,
              durationMs: ms - block.ms,
            },
          })
        }
        break
      }
      case 'tool-call':
        if (!isFileChangeEcho(part)) pending.set(str(part.toolCallId), { ms, part })
        break
      case 'tool-result':
      case 'tool-error': {
        if (isFileChangeEcho(part)) break
        const id = str(part.toolCallId)
        const call = pending.get(id)
        if (!call) break
        pending.delete(id)
        toolDone(id, call, stamped, part.type === 'tool-error')
        break
      }
      case 'error':
        out.push({ at: ms, event: { ...stamp(ms), type: 'error', message: errorText(part.error) } })
        break
      // A step that failed while the turn went on: a model call the harness retried (agy's
      // `error_message` steps). Not an `error`: that's what failed the turn, and an `error` part
      // would end it.
      case 'finish-step':
        if (part.finishReason === 'error') {
          const message = `A model call failed (${str(part.rawFinishReason) || 'error'}), and the agent retried it`
          out.push({ at: ms, event: { ...stamp(ms), type: 'retry', message } })
        }
        break
    }
  }
  const streamEndMs = parts.at(-1)?.ms
  // Calls still open when the turn ended (aborted, or the harness never reported a result):
  // `ok: null`, not known to have failed.
  for (const [id, call] of pending) {
    const name = toolName(call.part)
    const input = record(call.part.input)
    const t = timing.get(id)
    const start = t?.start ?? call.ms
    const durationMs =
      streamEndMs === undefined ? null : toolDurationMs(start, call, streamEndMs, t)
    const subagent = str(call.part.subagent)
    const base = {
      ...stamp(call.ms),
      durationMs,
      ...stallFlags(name, durationMs),
      ...(subagent ? { subagent } : {}),
    }
    if (name === 'webSearch') {
      out.push({
        at: call.ms,
        event: {
          ...base,
          type: 'web-search',
          toolCallId: id,
          query: str(input.searchTerm) || str(input.query),
          references: null,
          ok: null,
        },
      })
      continue
    }
    if (name === 'webFetch' || name === 'WebFetch') {
      out.push({
        at: call.ms,
        event: {
          ...base,
          type: 'web-fetch',
          toolCallId: id,
          url: str(input.url),
          ok: null,
        },
      })
      continue
    }
    out.push({
      at: call.ms,
      event: {
        ...base,
        type: 'tool',
        toolCallId: id,
        tool: name,
        input: toolInput(call.part),
        output: null,
        ok: null,
      },
    })
  }
  for (const [, block] of blocks) {
    if (block.text.trim()) {
      out.push({
        at: block.ms,
        event: { ...stamp(block.ms), type: block.type, text: block.text, durationMs: null },
      })
    }
  }
  return out.sort((a, b) => a.at - b.at).map((e) => e.event)
}

/**
 * A turn's reasoning time, from the reasoning blocks the harness streamed; null when it can't be
 * known. A harness whose reasoning arrives whole (`whole`) or not at all (`none`) can't time it.
 * A streamed turn with no reasoning block has spent none only when its usage says it used no
 * reasoning tokens; otherwise the model may have reasoned without the harness showing it.
 */
export function reasoningTime(
  delivery: ReasoningDelivery,
  events: readonly TranscriptEvent[],
  usage: TokenUsage | null,
): number | null {
  if (delivery !== 'streamed') return null
  const blocks = events.flatMap((e) => (e.type === 'reasoning' ? [e.durationMs] : []))
  if (blocks.length === 0) return usage?.reasoning === 0 ? 0 : null
  if (blocks.some((ms) => ms === null)) return null
  return blocks.reduce((n: number, ms) => n + (ms ?? 0), 0)
}
