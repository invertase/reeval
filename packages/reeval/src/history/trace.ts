// `reeval show --trace`: a run as Chrome Trace Event JSON, the format Perfetto (ui.perfetto.dev)
// and chrome://tracing open. Each lane is a track holding attempts that didn't overlap, with each
// attempt's phases nested under it and, where the transcript was kept, its tool calls under its
// turns. A record has each turn's start but only each phase's total, so setup is placed from the
// attempt's start and the diff, checks and judge after the last turn, marked `placed: estimated`.
import { clip } from '../text.ts'
import { commandLine } from '../view/judgments.ts'
import type { TranscriptLine } from '../view/model.ts'
import type { AttemptRecord, RunRecord } from './types.ts'

/** One Trace Event: `X` a slice, `i` an instant, `C` a counter sample, `M` a track's name. */
export type TraceEvent = {
  name: string
  ph: 'X' | 'i' | 'C' | 'M'
  /** Microseconds since the run started. */
  ts: number
  dur?: number
  pid: number
  tid: number
  cat?: string
  s?: 't'
  args?: Record<string, unknown>
}

export type RunTrace = {
  traceEvents: TraceEvent[]
  displayTimeUnit: 'ms'
  otherData: { runId: string; lanes: number; attempts: number }
}

/** A slice before nesting: `[start, end)` in epoch ms; `rank` orders slices that start together. */
type Span = {
  name: string
  start: number
  end: number
  rank: number
  cat: string
  args?: Record<string, unknown>
}

/** The run's own track, a process of its own: Perfetto names a thread after its id too. */
const RUN = { pid: 1, tid: 1 }
/** The lanes' process; lane `n` is thread `n`, named `lane`, so its track reads `lane n`. */
const LANES = 2

/** The attempt's transcript lines, by its key; an attempt without one gets no tool slices. */
export type Transcripts = ReadonlyMap<string, readonly TranscriptLine[]>

export function runTrace(run: RunRecord, transcripts: Transcripts = new Map()): RunTrace {
  const runStart = Date.parse(run.startedAt)
  const attempts = run.evals
    .flatMap((e) => e.attempts.map((a) => ({ evalName: e.name, a })))
    .filter((x): x is { evalName: string; a: AttemptRecord & { startedAt: string } } =>
      Boolean(x.a.startedAt),
    )
    .map((x) => {
      const start = Date.parse(x.a.startedAt)
      return { ...x, start, end: start + Math.max(0, x.a.durationMs) }
    })
    .sort((x, y) => x.start - y.start || (x.a.seq ?? 0) - (y.a.seq ?? 0))
  const base = Math.min(runStart, ...attempts.map((x) => x.start))
  const us = (ms: number) => Math.round((ms - base) * 1000)

  const lanes: Array<{ end: number; spans: Span[] }> = []
  for (const x of attempts) {
    let lane = lanes.find((l) => l.end <= x.start)
    if (!lane) {
      lane = { end: 0, spans: [] }
      lanes.push(lane)
    }
    lane.end = x.end
    lane.spans.push(...attemptSpans(x.evalName, x.a, x.start, x.end, transcripts))
  }
  const laneEnds = lanes.map((l) => l.end)

  const meta = (name: string, pid: number, tid: number, args: Record<string, unknown>) =>
    ({ name, ph: 'M', ts: 0, pid, tid, args }) as const
  const events: TraceEvent[] = [
    meta('process_name', RUN.pid, RUN.tid, { name: `run ${run.runId}` }),
    meta('process_sort_index', RUN.pid, RUN.tid, { sort_index: 0 }),
    meta('thread_name', RUN.pid, RUN.tid, { name: 'run' }),
    meta('process_name', LANES, 0, { name: 'attempts' }),
    meta('process_sort_index', LANES, 0, { sort_index: 1 }),
  ]
  const runEnd = Math.max(Date.parse(run.endedAt), ...laneEnds)
  const runSpans: Span[] = [
    {
      name: `run ${run.status}`,
      start: base,
      end: runEnd,
      rank: 0,
      cat: 'run',
      args: { runId: run.runId, status: run.status },
    },
  ]
  const first = attempts[0]?.start
  if (first !== undefined && first > runStart)
    runSpans.push({
      name: 'before the first attempt (plan, preflight)',
      start: runStart,
      end: first,
      rank: 1,
      cat: 'run',
    })
  events.push(...nest(runSpans).map((s) => slice(s, RUN.pid, RUN.tid, us)))
  for (const [i, { spans }] of lanes.entries()) {
    const tid = i + 1
    events.push(
      meta('thread_name', LANES, tid, { name: 'lane' }),
      meta('thread_sort_index', LANES, tid, { sort_index: tid }),
    )
    for (const s of nest(spans)) {
      events.push(
        s.end > s.start
          ? slice(s, LANES, tid, us)
          : {
              name: s.name,
              ph: 'i',
              s: 't',
              ts: us(s.start),
              pid: LANES,
              tid,
              cat: s.cat,
              ...(s.args ? { args: s.args } : {}),
            },
      )
    }
  }
  const changes = attempts
    .flatMap((x) => [
      { at: x.start, d: 1 },
      { at: x.end, d: -1 },
    ])
    .sort((x, y) => x.at - y.at || x.d - y.d)
  let running = 0
  for (const c of changes) {
    running += c.d
    events.push({
      name: 'attempts',
      ph: 'C',
      ts: us(c.at),
      ...RUN,
      args: { running },
    })
  }
  return {
    traceEvents: events,
    displayTimeUnit: 'ms',
    otherData: { runId: run.runId, lanes: lanes.length, attempts: attempts.length },
  }
}

const slice = (s: Span, pid: number, tid: number, us: (ms: number) => number): TraceEvent => ({
  name: s.name,
  ph: 'X',
  ts: us(s.start),
  dur: Math.max(0, us(s.end) - us(s.start)),
  pid,
  tid,
  cat: s.cat,
  ...(s.args ? { args: s.args } : {}),
})

const ESTIMATED = { placed: 'estimated' }

function attemptSpans(
  evalName: string,
  a: AttemptRecord,
  start: number,
  end: number,
  transcripts: Transcripts,
): Span[] {
  const within = (s: number, e: number) => {
    const from = Math.min(Math.max(s, start), end)
    return { start: from, end: Math.min(Math.max(e, from), end) }
  }
  const spans: Span[] = [
    {
      name: `${evalName} ${a.id}`,
      start,
      end,
      rank: 0,
      cat: 'attempt',
      args: {
        key: a.key,
        outcome: a.outcome,
        ...(a.error ? { error: clip(a.error.message, 500) } : {}),
        ...a.timings,
      },
    },
  ]
  const turns = a.turns.map((t, i) => {
    const s = Date.parse(t.startedAt)
    return { i, t, ...within(s, s + t.durationMs) }
  })
  const firstTurn = turns[0]?.start ?? end
  const { setupMs, diffMs, checksMs, judgeMs } = a.timings
  let cursor = start
  if (setupMs > 0) {
    const setup = within(start, Math.min(start + setupMs, firstTurn))
    spans.push({ name: 'setup', ...setup, rank: 1, cat: 'phase', args: { setupMs } })
    cursor = setup.end
  }
  const lines = transcripts.get(a.key) ?? []
  for (const { i, t, start: s, end: e } of turns) {
    spans.push({
      name: `turn ${i + 1}`,
      start: s,
      end: e,
      rank: 1,
      cat: 'phase',
      args: {
        status: t.status,
        prompt: clip(t.prompt, 500),
        ...(t.model ? { model: t.model } : {}),
      },
    })
    cursor = Math.max(cursor, e)
    for (const line of lines) {
      if (line.turn !== i || !('ts' in line) || typeof line.ts !== 'string') continue
      const event = eventSpan(line)
      if (!event) continue
      const at = Date.parse(line.ts)
      if (Number.isNaN(at)) continue
      const placed = { start: Math.min(Math.max(at, s), e), end: 0 }
      placed.end = Math.min(Math.max(at + event.ms, placed.start), e)
      spans.push({ name: event.name, ...placed, rank: 2, cat: event.cat, args: event.args })
    }
  }
  const after = (name: string, ms: number, args: Record<string, unknown>) => {
    if (ms <= 0) return
    const placed = within(cursor, cursor + ms)
    spans.push({ name, ...placed, rank: 1, cat: 'phase', args: { ...args, ...ESTIMATED } })
    cursor = placed.end
  }
  after('diff', diffMs, { diffMs })
  const checkMs = a.checks.reduce((n, c) => n + c.durationMs, 0)
  if (a.checks.length) {
    for (const c of a.checks)
      after(`check ${commandLine(c.command, 60)}`, c.durationMs, { exitCode: c.exitCode })
    after('checks', checksMs - checkMs, { checksMs })
  } else after('checks', checksMs, { checksMs })
  after(a.judgements.length > 1 ? `judge ×${a.judgements.length}` : 'judge', judgeMs, {
    judgeMs,
    verdicts: a.judgements.map((j) => `${j.verdict} ${j.score}: ${clip(j.question, 120)}`),
  })
  return spans
}

function eventSpan(
  line: TranscriptLine,
): { name: string; ms: number; cat: string; args: Record<string, unknown> } | null {
  const ms = 'durationMs' in line && typeof line.durationMs === 'number' ? line.durationMs : 0
  switch (line.type) {
    case 'tool':
      return { name: line.tool, ms, cat: 'tool', args: { ok: line.ok } }
    case 'file-edit':
      return { name: `${line.kind} ${line.path}`, ms, cat: 'tool', args: { path: line.path } }
    case 'web-search':
      return { name: 'web search', ms, cat: 'tool', args: { query: clip(line.query, 200) } }
    case 'web-fetch':
      return { name: 'web fetch', ms, cat: 'tool', args: { url: clip(line.url, 200) } }
    case 'text':
    case 'reasoning':
      return { name: line.type, ms, cat: line.type, args: { text: clip(line.text, 200) } }
    case 'error':
    case 'retry':
      return { name: line.type, ms: 0, cat: line.type, args: { message: clip(line.message, 500) } }
    default:
      return null
  }
}

/**
 * The spans of one track, clipped so each lies inside the one it starts in: a track's `X`
 * slices must nest, and parallel tool calls or a subagent's calls can overlap.
 */
function nest(spans: Span[]): Span[] {
  const sorted = [...spans].sort((x, y) => x.start - y.start || x.rank - y.rank || y.end - x.end)
  const open: Span[] = []
  return sorted.map((s) => {
    while (open.length && (open.at(-1) as Span).end <= s.start) open.pop()
    const parent = open.at(-1)
    const span = parent && s.end > parent.end ? { ...s, end: Math.max(s.start, parent.end) } : s
    if (span.end > span.start) open.push(span)
    return span
  })
}
