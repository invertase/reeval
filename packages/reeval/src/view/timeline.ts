// Where a turn's time went: its tool calls (durations the harness didn't report inferred from
// the next event), its model calls, and the background jobs it waited on, swept into one
// segmented timeline whose totals are the turn's `timeSplit`. Browser-safe: the studio draws it.
import type { TimeSplit, TranscriptEvent } from '../types.ts'

type ToolLike = Extract<
  TranscriptEvent,
  { type: 'file-edit' | 'web-search' | 'web-fetch' | 'tool' }
>

export type SegmentKind = 'waiting' | 'tool' | 'model' | 'other'

/** One stretch of a turn, in ms since it started. */
export type Segment = { kind: SegmentKind; startMs: number; endMs: number }

/** A background job the agent waited on: the call that started it (or the first poll), to the last poll's end. */
export type WaitSpan = {
  startMs: number
  endMs: number
  background: number | null
  polls: number[]
}

const isToolLike = (e: TranscriptEvent): e is ToolLike =>
  e.type === 'file-edit' || e.type === 'web-search' || e.type === 'web-fetch' || e.type === 'tool'

/**
 * The events with each tool call's missing `durationMs` run to the next event's `atMs` (the
 * turn's end for the last), flagged `durationInferred`.
 */
export function inferDurations(
  events: readonly TranscriptEvent[],
  turnMs: number,
): TranscriptEvent[] {
  return events.map((e, i) => {
    if (!isToolLike(e) || e.durationMs !== null) return e
    const next = events.slice(i + 1).find((n) => n.type !== 'model-call' && n.atMs > e.atMs)
    const end = Math.max(e.atMs, next ? next.atMs : turnMs)
    return { ...e, durationMs: end - e.atMs, durationInferred: true as const }
  })
}

const SHELL_TOOL = /shell|bash|terminal|command|exec/i
const OUTPUT_TOOL = /^(bash_?output|task_?output|await_?shell)$/i
const CURSOR_TERMINAL = /\.cursor\/projects\/[^"]*\/terminals\/[^"/]+\.txt/
const TERMINAL_COMMAND = /command:\s*("(?:[^"\\]|\\.)*")/

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

/** A shell call's command, or null for another tool. */
function commandOf(e: TranscriptEvent): string | null {
  if (e.type !== 'tool' || !SHELL_TOOL.test(e.tool) || OUTPUT_TOOL.test(e.tool)) return null
  const input = record(e.input)
  const command = input.command ?? input.cmd
  return typeof command === 'string' ? command.trim() : null
}

const strings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []

const textOf = (v: unknown) => (typeof v === 'string' ? v : (JSON.stringify(v) ?? ''))

/** The command a Cursor terminal file's header names, from a read of it. */
function terminalCommand(e: TranscriptEvent): string | null {
  if (e.type !== 'tool') return null
  const match = strings(e.output)
    .map((text) => TERMINAL_COMMAND.exec(text))
    .find(Boolean)
  if (!match?.[1]) return null
  try {
    return String(JSON.parse(match[1])).trim()
  } catch {
    return null
  }
}

function backgrounded(e: TranscriptEvent, named: ReadonlySet<string>): boolean {
  if (e.type !== 'tool') return false
  const input = record(e.input)
  if (input.run_in_background === true || input.is_background === true) return true
  const command = commandOf(e)
  if (command === null) return false
  return (
    /(^|[^&])&$/.test(command) || /(^|[\s;&|])(nohup|setsid)\s/.test(command) || named.has(command)
  )
}

function polls(e: TranscriptEvent): boolean {
  if (e.type !== 'tool') return false
  if (OUTPUT_TOOL.test(e.tool)) return true
  const command = commandOf(e)
  if (command !== null) return /^(sleep|wait)(\s|$)/.test(command)
  return CURSOR_TERMINAL.test(textOf(e.input))
}

const endOf = (e: ToolLike) => e.atMs + (e.durationMs ?? 0)

/** Work that ends a wait no poll has checked yet: an edit, or another command. */
const works = (e: ToolLike) => e.type === 'file-edit' || commandOf(e) !== null

/**
 * The background jobs the agent waited on, a heuristic over the transcript: a span opens at a
 * call run in the background or a poll and takes in each poll after it. Until its first poll,
 * lookups (reads, searches) leave it open and an edit or another command drops it; after it,
 * the next call that isn't a poll closes it. A background call no poll followed isn't waited on.
 */
export function waitSpans(events: readonly TranscriptEvent[]): WaitSpan[] {
  const named = new Set(events.map(terminalCommand).filter((c): c is string => c !== null))
  const spans: WaitSpan[] = []
  let open: WaitSpan | null = null
  const close = () => {
    if (open?.polls.length) spans.push(open)
    open = null
  }
  events.forEach((e, i) => {
    if (!isToolLike(e) || e.subagent) return
    if (backgrounded(e, named)) {
      if (open?.polls.length) close()
      open ??= { startMs: e.atMs, endMs: endOf(e), background: i, polls: [] }
    } else if (polls(e)) {
      open ??= { startMs: e.atMs, endMs: e.atMs, background: null, polls: [] }
      open.polls.push(i)
      open.endMs = Math.max(open.endMs, endOf(e))
    } else if (open?.polls.length || works(e)) close()
  })
  close()
  return spans
}

const PRIORITY: SegmentKind[] = ['waiting', 'tool', 'model']

/** The turn from 0 to `turnMs` as segments, each moment the first of waiting, tool, model and other. */
export function segments(events: readonly TranscriptEvent[], turnMs: number): Segment[] {
  const marks: Array<{ at: number; kind: number; delta: 1 | -1 }> = []
  const add = (kind: number, start: number, end: number) => {
    const s = Math.max(0, Math.min(turnMs, start))
    const e = Math.max(0, Math.min(turnMs, end))
    if (e <= s) return
    marks.push({ at: s, kind, delta: 1 }, { at: e, kind, delta: -1 })
  }
  for (const span of waitSpans(events)) add(0, span.startMs, span.endMs)
  for (const e of events) {
    if (isToolLike(e)) add(1, e.atMs, endOf(e))
    else if (e.type === 'model-call' && !e.stream) add(2, e.atMs, e.atMs + e.durationMs)
  }
  marks.sort((a, b) => a.at - b.at)
  const depth = [0, 0, 0]
  const out: Segment[] = []
  let at = 0
  const push = (kind: SegmentKind, end: number) => {
    if (end <= at) return
    const last = out.at(-1)
    if (last?.kind === kind) last.endMs = end
    else out.push({ kind, startMs: at, endMs: end })
    at = end
  }
  const current = (): SegmentKind => PRIORITY[depth.findIndex((d) => d > 0)] ?? 'other'
  for (const m of marks) {
    push(current(), m.at)
    depth[m.kind] = (depth[m.kind] ?? 0) + m.delta
  }
  push(current(), turnMs)
  return out
}

/** A turn's `timeSplit`, from its transcript (durations inferred) and length. */
export function timeSplit(events: readonly TranscriptEvent[], turnMs: number): TimeSplit {
  const total = { waiting: 0, tool: 0, model: 0, other: 0 }
  for (const s of segments(events, turnMs)) total[s.kind] += s.endMs - s.startMs
  const seen = events.some((e) => e.type === 'model-call' && !e.stream)
  const waitingMs = Math.round(total.waiting)
  const toolMs = Math.round(total.tool)
  const modelMs = Math.round(total.model)
  return {
    modelMs: seen ? modelMs : null,
    toolMs,
    waitingMs,
    otherMs: Math.max(0, Math.round(turnMs) - waitingMs - toolMs - modelMs),
  }
}

/** The turns' splits summed; `modelMs` null when any turn's is, undefined with none. */
export function sumSplits(splits: ReadonlyArray<TimeSplit | undefined>): TimeSplit | undefined {
  const known = splits.filter((s): s is TimeSplit => s !== undefined)
  if (known.length === 0) return undefined
  const sum = (f: (s: TimeSplit) => number) => known.reduce((n, s) => n + f(s), 0)
  return {
    modelMs: known.every((s) => s.modelMs !== null) ? sum((s) => s.modelMs ?? 0) : null,
    toolMs: sum((s) => s.toolMs),
    waitingMs: sum((s) => s.waitingMs),
    otherMs: sum((s) => s.otherMs),
  }
}

/** Each event's part in a wait, by index: the call that went to the background, or a poll. */
export function waitRoles(events: readonly TranscriptEvent[]): Map<number, 'background' | 'poll'> {
  const roles = new Map<number, 'background' | 'poll'>()
  for (const span of waitSpans(events)) {
    if (span.background !== null) roles.set(span.background, 'background')
    for (const i of span.polls) roles.set(i, 'poll')
  }
  return roles
}
