import { SANDBOX_ROOT, WORKSPACE_DIR } from '@evalsuite/sandbox-docker'
import type { FileEditEvent, TranscriptEvent } from '../types.ts'

/** One stream part and when it arrived, in ms since the turn started. */
export type StampedPart = { ms: number; part: { type: string; [key: string]: unknown } }

type Pending = { ms: number; part: StampedPart['part'] }
/** `at` places a call recovered after the turn where it happened, not where it was reported. */
type Timing = { start?: number; end?: number; at?: number }

const str = (value: unknown) => (typeof value === 'string' ? value : '')
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

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

/**
 * Cursor's edit tools take `path`, Claude Code's `file_path` and OpenCode's `filePath`, which is
 * made relative to the workspace, as Cursor's are.
 */
const editPath = (input: Record<string, unknown>) => {
  const opencode = str(input.filePath)
  return (
    str(input.path) ||
    str(input.file_path) ||
    (opencode.startsWith(WORKSPACE) ? opencode.slice(WORKSPACE.length) : opencode)
  )
}

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
 * harnesses (OpenCode) the tool's `rawOutput`, `{ error }`. Any other object is kept as JSON.
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
  deleted: boolean,
  input: Record<string, unknown>,
): FileEditEvent[] {
  if (deleted) {
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
    const body = lines(patch).filter((l) => !l.startsWith('+++') && !l.startsWith('---'))
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
  const opencode = record(result.metadata)
  // OpenCode's edit reports a `filediff` with counts; its write says whether the file `exists`.
  const filediff = record(opencode.filediff)
  if (typeof filediff.additions === 'number') {
    return [
      {
        type: 'file-edit',
        toolCallId,
        path: editPath(input),
        kind: 'modify',
        added: filediff.additions,
        removed: typeof filediff.deletions === 'number' ? filediff.deletions : null,
      },
    ]
  }
  if (typeof opencode.exists === 'boolean') {
    return [
      {
        type: 'file-edit',
        toolCallId,
        path: editPath(input),
        kind: opencode.exists ? 'modify' : 'create',
        added: opencode.exists ? null : lines(str(input.content)).length,
        removed: opencode.exists ? null : 0,
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

/**
 * Turns an AI SDK harness stream into ES transcript events: text and reasoning blocks joined,
 * each tool call merged with its result, edits normalised to `file-edit`, web tools given their
 * query or URL, and the harness's duplicate `fileChange` events dropped. Cursor's tool durations
 * come from its runner's own `tool_call` events, because tool results are only flushed at the
 * end of a step.
 */
export function normaliseStream(parts: StampedPart[], startedAt: number): TranscriptEvent[] {
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
    if (ended !== undefined) t.end = ended
    else if (event.status === 'completed' || event.status === 'error') t.end = ms
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
    const durationMs = t?.end !== undefined ? t.end - start : end.ms - call.ms
    call = t?.at === undefined ? call : { ...call, ms: t.at }
    const input = record(call.part.input)
    const name = toolName(call.part)
    const raw = failed ? errorText(end.part.error) : end.part.output
    // Antigravity runs commands in a PTY, so their output has CRLF line endings.
    const output = name === 'bash' && typeof raw === 'string' ? raw.replace(/\r\n/g, '\n') : raw
    const base = { ...stamp(call.ms), durationMs }
    if ((name === 'edit' || name === 'write' || name === 'delete') && !failed) {
      for (const edit of fileEdits(id, output, name === 'delete', input)) {
        out.push({ at: call.ms, event: { ...base, ...edit } })
      }
      return
    }
    if (name === 'webSearch' && !failed) {
      out.push({
        at: call.ms,
        event: {
          ...base,
          type: 'web-search',
          toolCallId: id,
          query: str(input.searchTerm) || str(input.query),
          references: searchReferences(output),
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
        input: call.part.input,
        output,
        ok: !failed,
      },
    })
  }

  for (const stamped of parts) {
    const { ms, part } = stamped
    switch (part.type) {
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
    }
  }
  // Calls still open when the turn ended (aborted, or the harness never reported a result).
  for (const [id, call] of pending) {
    out.push({
      at: call.ms,
      event: {
        ...stamp(call.ms),
        type: 'tool',
        toolCallId: id,
        tool: toolName(call.part),
        input: call.part.input,
        output: null,
        ok: false,
        durationMs: null,
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
