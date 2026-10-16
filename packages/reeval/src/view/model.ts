import { sampleReasons } from '../compare/pairs.ts'
import type {
  AttemptRecord,
  CellRecord,
  EvalEntry,
  HistoryCell,
  HistoryEntry,
  RunRecord,
} from '../history/types.ts'
import type { Outcome, TokenUsage, TranscriptEvent, TurnStatus } from '../types.ts'
import { promptTokens } from '../usage.ts'
import {
  type CompareCell,
  type CompareRow,
  type CompareStatus,
  cellsChanged,
  compare,
  type StackChange,
  stackChanges,
} from './compare.ts'
import { type CellEffort, cellContrast, cellEffort, type EffortContrast } from './effort.ts'
import { cellJudgeRates, cellUsage, type JudgeKeyRate, uniqueJudgeLabels } from './judgements.ts'
import { manifestPath, shardOf, shardPath } from './paths.ts'
import { readableTranscriptLine } from './record.ts'

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
  /** `debug`: local debug data (`.reeval/debug`) can be read; never in a static build. */
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

/**
 * A harness of the run's stack as `cursor (model composer-2.5, served composer-2.5[fast=true])`:
 * the configured model and reasoning effort, then what the harness says it resolved.
 */
export function harnessLabel(h: RunRecord['stack']['harnesses'][number]): string {
  const parts = [
    ...(h.model ? [`model ${h.model}`] : []),
    ...(h.effort ? [`reasoning effort ${h.effort}`] : []),
    ...(h.resolvedModels.length ? [`served ${h.resolvedModels.join(', ')}`] : []),
    ...(h.resolvedEffort.length ? [`served reasoning effort ${h.resolvedEffort.join(', ')}`] : []),
  ]
  return parts.length ? `${h.id} (${parts.join(', ')})` : h.id
}

/**
 * The runtime reeval ran on, as `node 22.14.0`, or `bun 1.4.2 (node 26.3.0)` with the Node version
 * it's compatible with. A run recorded before `stack.runtime` ran on Node.
 */
export function runtimeLabel(stack: Pick<RunRecord['stack'], 'node' | 'runtime'>): string {
  const runtime = stack.runtime ?? { name: 'node', version: stack.node }
  return runtime.name === 'node'
    ? `node ${runtime.version}`
    : `${runtime.name} ${runtime.version} (node ${stack.node})`
}

/** The evals' language as `typescript evals` or `dart 3.13.5 evals`; null when not recorded. */
export function languageLabel(stack: Pick<RunRecord['stack'], 'language'>): string | null {
  const language = stack.language
  if (!language) return null
  return `${language.version ? `${language.name} ${language.version}` : language.name} evals`
}

/** Harness-reported tokens as `127k in (98k cached) · 776 out`; null when none were reported. */
export function formatUsage(usage: TokenUsage | null | undefined): string | null {
  if (!usage) return null
  const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n))
  const cached = usage.cacheRead ? ` (${k(usage.cacheRead)} cached)` : ''
  return `${k(promptTokens(usage))} in${cached} · ${k(usage.output)} out`
}

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
 * A run's outcome, as `reeval run`'s exit code has it: a failed gated cell (or a budget stop) fails
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

function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Distinct judge labels that failed on a counted attempt, in first-seen order. */
export function failedJudgeLabels(record: Pick<RunRecord, 'evals'>): string[] {
  const seen = new Set<string>()
  const items: { key: string; question: string }[] = []
  for (const e of record.evals) {
    for (const a of e.attempts) {
      if (a.outcome !== 'pass' && a.outcome !== 'fail') continue
      for (const j of a.judgements) {
        if (j.verdict !== 'fail' || seen.has(j.key)) continue
        seen.add(j.key)
        items.push({ key: j.key, question: j.question })
      }
    }
  }
  const labels = uniqueJudgeLabels(items)
  return items.map((item) => labels.get(item.key) ?? item.key)
}

/**
 * One sentence for the studio run header: counted pass/fail, which judges failed, and infra.
 * Works without `reeval analyze`.
 */
export function runLead(record: Pick<RunRecord, 'summary' | 'evals'>): string {
  const { pass, fail, infraError } = record.summary
  const counted = pass + fail
  const judges = failedJudgeLabels(record)
  const parts: string[] = []
  if (counted === 0) parts.push('No counted attempts')
  else {
    parts.push(`${pass} of ${counted} counted attempts passed`)
    if (fail > 0) {
      parts.push(
        judges.length
          ? `${fail} failed the ${andList(judges)} judge${judges.length === 1 ? '' : 's'}`
          : `${fail} failed`,
      )
    }
  }
  if (infraError > 0) {
    parts.push(`${infraError} infra error${infraError === 1 ? '' : 's'}`)
  }
  return `${parts.join('; ')}.`
}

export type RunRow = {
  entry: HistoryEntry
  passed: number
  /** Attempts that reached a verdict or errored; skips excluded. */
  total: number
  /** Passes and fails, the denominator of the run's pass@1. */
  counted: number
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
      counted: pass + fail,
      drift: base ? stackChanges(base, entry) : [],
      changedEvals,
    })
    if (entry.status === 'complete') previous = entry
  }
  return rows.reverse()
}

// ── Run detail ───────────────────────────────────────────────────────────────────────────────

/** Attempt counts; `missed` is ungated cells' failures, which `fail` leaves out. */
export type Tally = { pass: number; fail: number; missed: number; infra: number; skipped: number }

export type TreeNode =
  | { kind: 'group'; key: string; name: string; tally: Tally; children: TreeNode[] }
  | { kind: 'eval'; key: string; name: string; tally: Tally; eval: EvalEntry }

const tallyOf = (e: EvalEntry): Tally => ({
  pass: e.attempts.filter((a) => a.outcome === 'pass').length,
  fail: e.attempts.filter((a) => a.outcome === 'fail' && !isUngatedMiss(e, a)).length,
  missed: e.attempts.filter((a) => isUngatedMiss(e, a)).length,
  infra: e.attempts.filter((a) => a.outcome === 'infra_error').length,
  skipped: e.attempts.filter((a) => a.outcome === 'skipped').length,
})

const addTally = (a: Tally, b: Tally): Tally => ({
  pass: a.pass + b.pass,
  fail: a.fail + b.fail,
  missed: a.missed + b.missed,
  infra: a.infra + b.infra,
  skipped: a.skipped + b.skipped,
})

const ZERO: Tally = { pass: 0, fail: 0, missed: 0, infra: 0, skipped: 0 }

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
  /** The reasoning effort the harness factory asked for; null when it left it unset. */
  reasoningEffort: string | null
  runs: number
  pass: number
  fail: number
  infraError: number
  skipped: number
  /** pass@1: passes over passes and fails. */
  passAt1: number | null
  outcome: Outcome
  /** A variant's lift over its control, in whole points (from the record), else null. */
  lift: number | null
  /** Its 95% interval in whole points, and whether that spans 0. */
  liftInterval: { lo: number; hi: number; withinNoise: boolean } | null
  /** The interval's lower bound is below the compare's `minLift`. */
  belowMinLift: boolean
  /** Median tool calls, agent time and tokens over the cell's counted attempts. */
  effort: CellEffort | null
  /** A variant's effort against its control, with the rank test's verdict. */
  effortVsControl: EffortContrast | null
  /** Per-key judge pass/counted over this cell's counted attempts. */
  judgeRates: JudgeKeyRate[]
  /** Sum of counted attempts' tokens; null when none reported. */
  usage: TokenUsage | null
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
    reasoningEffort: cell.effort ?? null,
    runs: cell.runs,
    pass: cell.pass,
    fail: cell.fail,
    infraError: cell.infraError,
    skipped: cell.skipped,
    passAt1: cell.passRate,
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
    effort: cellEffort(e, cell.key),
    effortVsControl: cellContrast(e, cell.key),
    judgeRates: cellJudgeRates(e, cell.key),
    usage: cellUsage(e, cell.key),
    attempts: e.attempts.filter((a) => a.cell === cell.key),
  }))
}

/** One side's wins over the decided votes it was in; `rate` is null when none decided. */
export type AnswerRate = { name: string; wins: number; n: number; rate: number | null }

export type AnswerRow = {
  question: string
  /** The model that answered: as served, when the provider said, else as configured. */
  model: string
  votes: number
  ties: number
  /** Arms against each other on one harness, then harnesses against each other on one arm. */
  within: AnswerRate[]
  across: AnswerRate[]
  /** Why some or all of its votes are missing: the model call failed. */
  error: string | null
  /** No votes and no error: no pair had both sides pass their checks. */
  noPairs: boolean
  /** Distinct vote reasons, in vote order, at most three. */
  reasons: string[]
}

/** One row per compare question, with each cut's win rates in the record's order. */
export function answerRows(e: Pick<EvalEntry, 'answers'>): AnswerRow[] {
  return (e.answers ?? []).map((a) => {
    const rates = (cut: string): AnswerRate[] =>
      a.rates
        .filter((r) => r.cut === cut)
        .map((r) => ({ name: r.name, wins: r.wins, n: r.n, rate: r.n ? r.wins / r.n : null }))
    return {
      question: a.question,
      model: a.resolvedModel ?? a.model,
      votes: a.votes.length,
      ties: a.votes.filter((v) => v.winner === 'tie').length,
      within: rates('within'),
      across: rates('across'),
      error: a.error ?? null,
      noPairs: a.votes.length === 0 && a.error === undefined,
      reasons: sampleReasons(a.votes),
    }
  })
}

/** Whether an eval needs the cells table: several cells, or several runs of one. */
export const isMatrix = (e: Pick<EvalEntry, 'cells'>) =>
  e.cells.length > 1 || e.cells.some((c) => c.runs > 1)

// ── Eval history ─────────────────────────────────────────────────────────────────────────────

export type EvalHistoryPoint = {
  run: HistoryEntry
  outcome: Outcome
  /** pass@1 over the gated cells' attempts. */
  passAt1: number | null
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
      passAt1: e.passRate,
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
  basePassAt1: number | null
  headPassAt1: number | null
  /** See `CompareRow`: then pass@1 is over the cells both runs have too. */
  cells?: CompareRow['cells']
  changes?: string[]
  /** Mean judge score per run; null without judgements or without the record. */
  baseScore: number | null
  headScore: number | null
  /** Cells in both runs, with lift and effort on each side. */
  perCell: CompareCell[]
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

/**
 * Whether some of an eval's cells aren't gated (`gate: 'none'`, e.g. controls under
 * `compare.gate: 'variants'`). Its pass@1 then covers fewer attempts than its pass count, so
 * the eval line labels it `gated`: `2/4 · pass@1 100% gated`.
 */
export const hasUngatedCells = (cells: readonly Pick<HistoryCell, 'gate'>[]) =>
  cells.some((c) => c.gate === 'none')

/**
 * An expected miss: a failed attempt in an ungated cell (a control, by default). It's reported
 * apart from failures, since it fails neither its eval nor the run.
 */
export const isUngatedMiss = (
  e: { cells: readonly Pick<HistoryCell, 'key' | 'gate'>[] },
  a: Pick<AttemptRecord, 'cell' | 'outcome' | 'error'>,
) =>
  a.outcome === 'fail' &&
  a.error?.kind !== 'aborted' &&
  e.cells.find((c) => c.key === a.cell)?.gate === 'none'

/** pass@1 in the gated cells, as an eval's `passRate` counts it. */
function gatedPassAt1(cells: HistoryCell[]): number | null {
  const gated = cells.filter((c) => c.gate !== 'none')
  const pass = gated.reduce((n, c) => n + c.pass, 0)
  const counted = pass + gated.reduce((n, c) => n + c.fail, 0)
  return counted ? pass / counted : null
}

/** `reeval compare`'s classification, plus pass@1 and judge-score deltas from the records. */
export function compareView(
  base: HistoryEntry,
  head: HistoryEntry,
  records: { base?: RunRecord; head?: RunRecord } = {},
) {
  const rows: CompareViewRow[] = compare(base, head).map((row) => {
    const b = base.evals.find((e) => e.id === row.id)
    const h = head.evals.find((e) => e.id === row.id)
    const baseKeys = new Set(b?.cells.map((c) => c.key))
    const shared =
      row.cells && new Set(h?.cells.filter((c) => baseKeys.has(c.key)).map((c) => c.key))
    const passAt1 = (e: typeof b) => {
      if (!e) return null
      return shared ? gatedPassAt1(e.cells.filter((c) => shared.has(c.key))) : e.passRate
    }
    return {
      ...row,
      slug: h?.slug ?? b?.slug ?? null,
      basePassAt1: passAt1(b),
      headPassAt1: passAt1(h),
      baseScore: meanScore(records.base?.evals.find((e) => e.id === row.id)),
      headScore: meanScore(records.head?.evals.find((e) => e.id === row.id)),
      perCell: row.perCell ?? [],
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
      if (value && typeof value.type === 'string') lines.push(readableTranscriptLine(value))
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
