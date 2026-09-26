import type {
  AttemptRecord,
  CellRecord,
  EvalEntry,
  HistoryCell,
  HistoryEntry,
  RunRecord,
} from '../history/types.ts'
import type { Outcome, TranscriptEvent, TurnStatus } from '../types.ts'
import {
  type CompareStatus,
  cellsChanged,
  compare,
  type StackChange,
  stackChanges,
} from './compare.ts'
import { manifestPath, shardOf, shardPath } from './paths.ts'

// ── Index ────────────────────────────────────────────────────────────────────────────────────

export type EvalCatalogEntry = {
  slug: string
  id: string
  file: string
  /** Group names, then the eval name. */
  path: string[]
  runs: number
  latest: { runId: string; outcome: Outcome }
}

export type IndexManifest = {
  generatedAt: string
  /** Newest first. */
  shards: Array<{ id: string; runs: number }>
  latest: string | null
  evals: EvalCatalogEntry[]
}

export type StudioInfo = {
  mode: 'live' | 'static'
  es: string
  project: string
  generatedAt: string
  /** `debug`: local debug data (`.es/debug`) can be read; never in a static build. */
  features: { live: boolean; scratch: boolean; artifacts: boolean; debug: boolean }
}

/** Splits `file › group › … › name` back into its parts. */
export function splitEvalId(id: string): { file: string; path: string[] } {
  const [file = id, ...path] = id.split(' › ')
  return { file, path: path.length ? path : [file] }
}

/** Month shards (newest run first) and the manifest over them, from every run's header. */
export function buildIndex(entries: HistoryEntry[], generatedAt = new Date().toISOString()) {
  const sorted = [...entries].sort((a, b) => (a.runId < b.runId ? 1 : -1))
  const shards = new Map<string, HistoryEntry[]>()
  for (const entry of sorted) {
    const id = shardOf(entry.startedAt)
    const list = shards.get(id) ?? []
    list.push(entry)
    shards.set(id, list)
  }
  const evals = new Map<string, EvalCatalogEntry>()
  for (const run of sorted) {
    for (const e of run.evals) {
      const known = evals.get(e.slug)
      if (known) {
        known.runs++
        continue
      }
      evals.set(e.slug, {
        slug: e.slug,
        id: e.id,
        ...splitEvalId(e.id),
        runs: 1,
        latest: { runId: run.runId, outcome: e.outcome },
      })
    }
  }
  const manifest: IndexManifest = {
    generatedAt,
    shards: [...shards].map(([id, runs]) => ({ id, runs: runs.length })),
    latest: sorted[0]?.runId ?? null,
    evals: [...evals.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
  }
  return { manifest, shards }
}

/** Every file the index consists of, by relative path. */
export function indexFiles(entries: HistoryEntry[], generatedAt?: string): Map<string, unknown> {
  const { manifest, shards } = buildIndex(entries, generatedAt)
  const files = new Map<string, unknown>([[manifestPath, manifest]])
  for (const [id, list] of shards) files.set(shardPath(id), list)
  return files
}

// ── Formatting ───────────────────────────────────────────────────────────────────────────────

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export const formatPercent = (rate: number | null) =>
  rate === null ? '–' : `${Math.round(rate * 100)}%`

export const formatCost = (usd: number | null) =>
  usd === null ? '–' : usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : 'no git')

/**
 * An attempt's effort, counted as the CLI's turn lines count it: tool calls, then file edits.
 * Edit calls become one file edit per file they change, so they're counted apart, never summed.
 */
export function activityLabel(a: Pick<AttemptRecord['activity'], 'tools' | 'fileEdits'>): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  return `${plural(a.tools, 'tool call')} · ${plural(a.fileEdits, 'file edit')}`
}

// ── Runs list ────────────────────────────────────────────────────────────────────────────────

/**
 * A run's outcome, as `es run`'s exit code has it: a failed gated cell (or a budget stop) fails
 * the run, while failures in ungated cells (controls, by default) don't.
 */
export function runOutcome(run: {
  status: RunRecord['status']
  evals: ReadonlyArray<{ outcome: Outcome }>
}): Outcome {
  if (run.status === 'interrupted') return 'skipped'
  const outcomes = run.evals.map((e) => e.outcome)
  if (outcomes.includes('fail') || run.status === 'budget') return 'fail'
  if (outcomes.includes('infra_error')) return 'infra_error'
  return 'pass'
}

export type RunRow = {
  entry: HistoryEntry
  passed: number
  /** Attempts that reached a verdict or errored; skips excluded. */
  total: number
  /** Stack changes in the cells it shares with earlier runs, and in the judge since the previous complete run. */
  drift: StackChange[]
  /** Evals with a cell whose fingerprint changed since the last run that had that cell. */
  changedEvals: number
}

/**
 * Newest first. Drift is measured per cell, against the last run that had it: a run over fewer
 * cells (a filtered run) is no drift, and neither is the full run after it. The judge's settings
 * compare with the next older complete run.
 */
export function runRows(entries: HistoryEntry[]): RunRow[] {
  const oldest = [...entries].sort((a, b) => (a.runId < b.runId ? -1 : 1))
  const seen = new Map<string, string>()
  const lastCells = new Map<string, Map<string, HistoryCell>>()
  let previous: HistoryEntry | null = null
  const rows: RunRow[] = []
  for (const entry of oldest) {
    const { pass, fail, infraError } = entry.summary
    const base = previous && {
      stack: previous.stack,
      evals: [...lastCells].map(([id, cells]) => ({ id, cells: [...cells.values()] })),
    }
    let changedEvals = 0
    for (const e of entry.evals) {
      if (cellsChanged(seen, e.id, e.cells)) changedEvals++
      const cells = lastCells.get(e.id) ?? new Map<string, HistoryCell>()
      for (const c of e.cells) cells.set(c.key, c)
      lastCells.set(e.id, cells)
    }
    rows.push({
      entry,
      passed: pass,
      total: pass + fail + infraError,
      drift: base ? stackChanges(base, entry) : [],
      changedEvals,
    })
    if (entry.status === 'complete') previous = entry
  }
  return rows.reverse()
}

// ── Run detail ───────────────────────────────────────────────────────────────────────────────

export type Tally = { pass: number; fail: number; infra: number; skipped: number }

export type TreeNode =
  | { kind: 'group'; key: string; name: string; tally: Tally; children: TreeNode[] }
  | { kind: 'eval'; key: string; name: string; tally: Tally; eval: EvalEntry }

const tallyOf = (e: EvalEntry): Tally => ({
  pass: e.attempts.filter((a) => a.outcome === 'pass').length,
  fail: e.attempts.filter((a) => a.outcome === 'fail').length,
  infra: e.attempts.filter((a) => a.outcome === 'infra_error').length,
  skipped: e.attempts.filter((a) => a.outcome === 'skipped').length,
})

const addTally = (a: Tally, b: Tally): Tally => ({
  pass: a.pass + b.pass,
  fail: a.fail + b.fail,
  infra: a.infra + b.infra,
  skipped: a.skipped + b.skipped,
})

const ZERO: Tally = { pass: 0, fail: 0, infra: 0, skipped: 0 }

/** Files, then groups, then evals, each with attempt counts; failing branches sort first. */
export function evalTree(record: Pick<RunRecord, 'evals'>): TreeNode[] {
  const root: Extract<TreeNode, { kind: 'group' }> = {
    kind: 'group',
    key: '',
    name: '',
    tally: ZERO,
    children: [],
  }
  for (const e of record.evals) {
    const trail = [e.file, ...e.group]
    let node = root
    for (const [i, name] of trail.entries()) {
      const key = trail.slice(0, i + 1).join(' › ')
      let child = node.children.find(
        (c): c is Extract<TreeNode, { kind: 'group' }> => c.kind === 'group' && c.key === key,
      )
      if (!child) {
        child = { kind: 'group', key, name, tally: ZERO, children: [] }
        node.children.push(child)
      }
      node = child
    }
    node.children.push({ kind: 'eval', key: e.id, name: e.name, tally: tallyOf(e), eval: e })
  }
  const finish = (n: TreeNode): TreeNode => {
    if (n.kind === 'eval') return n
    const children = n.children.map(finish)
    children.sort((a, b) => rank(a.tally) - rank(b.tally))
    return { ...n, children, tally: children.reduce((t, c) => addTally(t, c.tally), ZERO) }
  }
  return (finish(root) as Extract<TreeNode, { kind: 'group' }>).children
}

const rank = (t: Tally) => (t.fail ? 0 : t.infra ? 1 : t.pass ? 2 : 3)

export type CellRow = {
  key: string
  harness: string
  environment: string
  sandbox: string
  role: CellRecord['role']
  /** Whether the cell's failures fail the eval: its gate isn't `'none'`. */
  gated: boolean
  gate: CellRecord['gate']
  overrides: string[]
  runs: number
  pass: number
  fail: number
  infraError: number
  skipped: number
  passRate: number | null
  outcome: Outcome
  /** A variant's lift over its control, in whole points (from the record), else null. */
  lift: number | null
  /** Its 95% interval in whole points, and whether that spans 0. */
  liftInterval: { lo: number; hi: number; withinNoise: boolean } | null
  /** The interval's lower bound is below the compare's `minLift`. */
  belowMinLift: boolean
  attempts: AttemptRecord[]
}

/** One row per cell: controls and variants, with each variant's recorded lift. */
export function cellRows(e: EvalEntry): CellRow[] {
  return e.cells.map((cell) => ({
    key: cell.key,
    harness: cell.harness,
    environment: cell.environment,
    sandbox: cell.sandbox,
    role: cell.role,
    gated: cell.gate !== 'none',
    gate: cell.gate,
    overrides: cell.overrides,
    runs: cell.runs,
    pass: cell.pass,
    fail: cell.fail,
    infraError: cell.infraError,
    skipped: cell.skipped,
    passRate: cell.passRate,
    outcome: cell.outcome,
    lift: cell.lift ? Math.round(cell.lift.points * 100) : null,
    liftInterval: cell.lift
      ? {
          lo: Math.round(cell.lift.interval.lo * 100),
          hi: Math.round(cell.lift.interval.hi * 100),
          withinNoise: cell.lift.withinNoise,
        }
      : null,
    belowMinLift: cell.lift?.minLift !== undefined && cell.lift.interval.lo < cell.lift.minLift,
    attempts: e.attempts.filter((a) => a.cell === cell.key),
  }))
}

/** Whether an eval needs the cells table: several cells, or several runs of one. */
export const isMatrix = (e: Pick<EvalEntry, 'cells'>) =>
  e.cells.length > 1 || e.cells.some((c) => c.runs > 1)

// ── Eval history ─────────────────────────────────────────────────────────────────────────────

export type EvalHistoryPoint = {
  run: HistoryEntry
  outcome: Outcome
  passRate: number | null
  cells: HistoryCell[]
  /** A cell's fingerprint differs from the last run that had that cell. */
  changed: boolean
}

/** One eval across runs, oldest first. */
export function evalHistory(entries: HistoryEntry[], slug: string): EvalHistoryPoint[] {
  const oldest = [...entries].sort((a, b) => (a.runId < b.runId ? -1 : 1))
  const points: EvalHistoryPoint[] = []
  const seen = new Map<string, string>()
  for (const run of oldest) {
    const e = run.evals.find((x) => x.slug === slug)
    if (!e) continue
    points.push({
      run,
      outcome: e.outcome,
      passRate: e.passRate,
      cells: e.cells,
      changed: cellsChanged(seen, e.id, e.cells),
    })
  }
  return points
}

// ── Compare ──────────────────────────────────────────────────────────────────────────────────

export type CompareViewRow = {
  id: string
  slug: string | null
  status: CompareStatus
  base: Outcome | null
  head: Outcome | null
  basePassRate: number | null
  headPassRate: number | null
  /** Mean judge score per run; null without judgements or without the record. */
  baseScore: number | null
  headScore: number | null
}

const meanScore = (e: EvalEntry | undefined) => {
  const scores = e?.attempts.flatMap((a) => a.judgements.map((j) => j.score)) ?? []
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null
}

export const COMPARE_ORDER: CompareStatus[] = [
  'regressed',
  'fixed',
  'drift',
  'infra',
  'added',
  'removed',
  'same',
]

/** `es compare`'s classification, plus pass rates and judge-score deltas from the records. */
export function compareView(
  base: HistoryEntry,
  head: HistoryEntry,
  records: { base?: RunRecord; head?: RunRecord } = {},
) {
  const rows: CompareViewRow[] = compare(base, head).map((row) => {
    const b = base.evals.find((e) => e.id === row.id)
    const h = head.evals.find((e) => e.id === row.id)
    return {
      ...row,
      slug: h?.slug ?? b?.slug ?? null,
      basePassRate: b?.passRate ?? null,
      headPassRate: h?.passRate ?? null,
      baseScore: meanScore(records.base?.evals.find((e) => e.id === row.id)),
      headScore: meanScore(records.head?.evals.find((e) => e.id === row.id)),
    }
  })
  rows.sort((a, b) => COMPARE_ORDER.indexOf(a.status) - COMPARE_ORDER.indexOf(b.status))
  const counts = Object.fromEntries(
    COMPARE_ORDER.map((s) => [s, rows.filter((r) => r.status === s).length]),
  ) as Record<CompareStatus, number>
  return { rows, counts, changes: stackChanges(base, head) }
}

// ── Transcript ───────────────────────────────────────────────────────────────────────────────

export type TranscriptLine =
  | ({ turn: number } & TranscriptEvent)
  | { turn: number; ts: string; atMs: number; type: 'prompt'; text: string }
  | {
      turn: number
      ts: string
      atMs: number
      type: 'turn-end'
      status: TurnStatus
      durationMs: number
    }

export type TranscriptItem =
  | { kind: 'turn'; turn: number; prompt: string; ts: string }
  | { kind: 'event'; turn: number; event: TranscriptLine }
  | { kind: 'turn-end'; turn: number; status: TurnStatus; durationMs: number }

/** Parses `transcript.jsonl`, skipping lines that aren't JSON (a truncated tail, say). */
export function parseTranscript(text: string): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as TranscriptLine
      if (value && typeof value.type === 'string') lines.push(value)
    } catch {}
  }
  return lines
}

export function transcriptItems(lines: TranscriptLine[]): TranscriptItem[] {
  return lines.map((line) => {
    if (line.type === 'prompt') {
      return { kind: 'turn', turn: line.turn, prompt: line.text, ts: line.ts }
    }
    if (line.type === 'turn-end') {
      return { kind: 'turn-end', turn: line.turn, status: line.status, durationMs: line.durationMs }
    }
    return { kind: 'event', turn: line.turn, event: line }
  })
}

// ── Diffs ────────────────────────────────────────────────────────────────────────────────────

export type PatchFile = {
  path: string
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'binary'
  added: number
  removed: number
  text: string
}

const HEADER = /^diff --git a\/(.+?) b\/(.+)$/m

/** Splits a git patch into one entry per file, with line counts. */
export function splitPatch(patch: string): PatchFile[] {
  if (!patch.trim()) return []
  return patch
    .split(/(?=^diff --git )/m)
    .filter((part) => part.startsWith('diff --git '))
    .map((text) => {
      const header = HEADER.exec(text)
      const path = header?.[2] ?? header?.[1] ?? 'unknown'
      let added = 0
      let removed = 0
      for (const line of text.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++ ')) added++
        else if (line.startsWith('-') && !line.startsWith('--- ')) removed++
      }
      const status: PatchFile['status'] = /^new file mode/m.test(text)
        ? 'added'
        : /^deleted file mode/m.test(text)
          ? 'deleted'
          : /^rename from/m.test(text)
            ? 'renamed'
            : /^(Binary files|GIT binary patch)/m.test(text)
              ? 'binary'
              : 'modified'
      return { path, status, added, removed, text }
    })
}

// ── Lookups ──────────────────────────────────────────────────────────────────────────────────

export const findEval = (record: Pick<RunRecord, 'evals'>, slug: string) =>
  record.evals.find((e) => e.slug === slug)

export const findAttempt = (e: EvalEntry, attemptId: string) =>
  e.attempts.find((a) => a.id === attemptId)

/** The attempt to open by default: the first failure, else the first attempt. */
export const defaultAttempt = (e: EvalEntry) =>
  e.attempts.find((a) => a.outcome === 'fail' || a.outcome === 'infra_error') ?? e.attempts[0]
