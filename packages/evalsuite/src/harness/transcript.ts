import type { FileEditEvent, TranscriptEvent } from '../types.ts'

/** One stream part and when it arrived, in ms since the turn started. */
export type StampedPart = { ms: number; part: { type: string; [key: string]: unknown } }

type Pending = { ms: number; part: StampedPart['part'] }
type Timing = { start?: number; end?: number }

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

// Cursor sends new files as `oldText: "-- /dev/null"` and prefixes the content with a mangled
// `++ b//<abs path>` header line.
const NEW_FILE = /^-- \/dev\/null$/
const MANGLED_HEADER = /^\+\+ b\/[^\n]*\n?/

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
        path: str(input.path),
        kind: 'delete',
        added: 0,
        removed: null,
      },
    ]
  }
  const entries = Array.isArray(output) ? output.map(record) : []
  if (entries.length === 0) {
    return [
      {
        type: 'file-edit',
        toolCallId,
        path: str(input.path),
        kind: 'modify',
        added: null,
        removed: null,
      },
    ]
  }
  return entries.map((entry) => {
    const oldText = entry.oldText
    const created = oldText === null || oldText === undefined || NEW_FILE.test(str(oldText))
    const newText = created ? str(entry.newText).replace(MANGLED_HEADER, '') : str(entry.newText)
    const { added, removed } = lineDelta(created ? '' : str(oldText), newText)
    return {
      type: 'file-edit' as const,
      toolCallId,
      path: str(entry.path) || str(input.path),
      kind: created ? ('create' as const) : ('modify' as const),
      added,
      removed,
    }
  })
}

/**
 * Turns an AI SDK harness stream into ES transcript events: text and reasoning blocks joined,
 * each tool call merged with its result, edits normalised to `file-edit`, web tools given their
 * query or URL, and the harness's duplicate `fileChange` events dropped. Tool durations come
 * from the ACP `tool_call` / `tool_call_update` events, because tool results are only flushed
 * at the end of a step.
 */
export function normaliseStream(parts: StampedPart[], startedAt: number): TranscriptEvent[] {
  const timing = new Map<string, Timing>()
  for (const { ms, part } of parts) {
    if (part.type !== 'raw') continue
    const raw = record(part.rawValue)
    const id = str(raw.toolCallId)
    if (!id) continue
    const t = timing.get(id) ?? {}
    if (raw.sessionUpdate === 'tool_call' && t.start === undefined) t.start = ms
    if (raw.status === 'completed' || raw.status === 'failed') t.end = ms
    timing.set(id, t)
  }

  const out: Array<{ at: number; event: TranscriptEvent }> = []
  const stamp = (at: number) => ({ ts: new Date(startedAt + at).toISOString(), atMs: at })
  const blocks = new Map<string, { type: 'text' | 'reasoning'; ms: number; text: string }>()
  const pending = new Map<string, Pending>()

  const toolDone = (id: string, call: Pending, end: StampedPart, failed: boolean) => {
    const t = timing.get(id)
    const start = t?.start ?? call.ms
    const durationMs = t?.end !== undefined ? t.end - start : end.ms - call.ms
    const input = record(call.part.input)
    const name = str(call.part.toolName)
    const output = failed ? str(end.part.error) || String(end.part.error) : end.part.output
    const base = { ...stamp(call.ms), durationMs }
    if ((name === 'edit' || name === 'delete') && !failed) {
      for (const edit of fileEdits(id, output, name === 'delete', input)) {
        out.push({ at: call.ms, event: { ...base, ...edit } })
      }
      return
    }
    if (name === 'webSearch' && !failed) {
      const references = record(output).referenceCount
      out.push({
        at: call.ms,
        event: {
          ...base,
          type: 'web-search',
          toolCallId: id,
          query: str(input.searchTerm),
          references: typeof references === 'number' ? references : null,
        },
      })
      return
    }
    if (name === 'webFetch') {
      out.push({
        at: call.ms,
        event: {
          ...base,
          type: 'web-fetch',
          toolCallId: id,
          url: str(input.url),
          ok: !failed && record(output).success !== false,
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
        out.push({ at: ms, event: { ...stamp(ms), type: 'error', message: String(part.error) } })
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
        tool: str(call.part.toolName),
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
