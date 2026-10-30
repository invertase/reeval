// `reeval mcp`'s failures tool: why each failed attempt of a run failed, in one answer sized for an
// agent's context, and whether its cell failed before.
import { join } from 'node:path'
import { allRuns } from '../commands.ts'
import { readRecord, scratchDir } from '../history/files.ts'
import { toolTarget } from '../history/tool-target.ts'
import type {
  AttemptRecord,
  CellRecord,
  EvalEntry,
  FingerprintParts,
  HistoryCell,
  HistoryEntry,
  RunRecord,
} from '../history/types.ts'
import { resolveRun } from '../history/views.ts'
import type { ResolvedConfig } from '../types.ts'
import { gateLabel } from '../view/gate.ts'
import type { TranscriptLine } from '../view/model.ts'
import { fileTail, transcriptLines } from './files.ts'

export const DEFAULT_FAILURES = 10
export const DEFAULT_TAIL = 12

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`

const asText = (value: unknown) =>
  typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)

/** One transcript line, cut down to what says what happened. Line numbers count from 1. */
function compactLine(line: TranscriptLine, n: number): Record<string, unknown> | null {
  switch (line.type) {
    case 'prompt':
      return { line: n, turn: line.turn, prompt: clip(line.text, 300) }
    case 'text':
      return { line: n, turn: line.turn, text: clip(line.text, 600) }
    case 'tool':
      return {
        line: n,
        turn: line.turn,
        tool: line.tool,
        target: toolTarget(line.input, line.tool),
        ok: line.ok,
        output: clip(asText(line.output), 400),
      }
    case 'file-edit':
      return { line: n, turn: line.turn, edit: line.path, kind: line.kind }
    case 'web-search':
      return {
        line: n,
        turn: line.turn,
        tool: 'web-search',
        target: line.query,
        ok: line.ok === undefined ? true : line.ok,
      }
    case 'web-fetch':
      return { line: n, turn: line.turn, tool: 'web-fetch', target: line.url, ok: line.ok }
    case 'error':
    case 'retry':
      return { line: n, turn: line.turn, [line.type]: clip(line.message, 600) }
    case 'turn-end':
      return { line: n, turn: line.turn, turnEnd: line.status }
    default:
      return null
  }
}

function transcriptTail(lines: TranscriptLine[], tail: number) {
  const compact = lines.flatMap((line, i) => {
    const c = compactLine(line, i + 1)
    return c ? [c] : []
  })
  return { lines: lines.length, tail: compact.slice(-tail) }
}

const failedHere = (c: Pick<HistoryCell, 'fail' | 'infraError'>) => c.fail > 0 || c.infraError > 0

/** The parts that differ; the gate from the cells, since a record from before it was a part has none. */
const changedParts = (a: Pick<HistoryCell, 'gate' | 'fingerprintParts'>, b: typeof a) => {
  const { fingerprintParts: x } = a
  const { fingerprintParts: y } = b
  const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])] as Array<keyof FingerprintParts>
  const parts = keys.filter((k) => k !== 'gate' && x[k] !== y[k])
  return gateLabel(a.gate) === gateLabel(b.gate) ? parts : [...parts, 'gate' as const]
}

function changedSources(
  now: EvalEntry['sources'],
  before: HistoryEntry['evals'][number]['sources'],
): string[] {
  const old = new Map(before.map((s) => [s.path, s.sha256]))
  const paths = now.filter((s) => old.get(s.path) !== s.sha256).map((s) => s.path)
  const kept = new Set(now.map((s) => s.path))
  return [...paths, ...before.filter((s) => !kept.has(s.path)).map((s) => `${s.path} (removed)`)]
}

/**
 * The cell's earlier runs, newest first: whether this failure is new, the last run where the cell
 * passed cleanly, the run its failing streak started in, and what changed since that clean run.
 */
function cellHistory(entries: HistoryEntry[], run: RunRecord, e: EvalEntry, cell: CellRecord) {
  const earlier: Array<{
    entry: HistoryEntry
    eval: HistoryEntry['evals'][number]
    cell: HistoryCell
  }> = []
  for (const entry of entries) {
    if (entry.runId >= run.runId) continue
    const ev = entry.evals.find((x) => x.key === e.key)
    const c = ev?.cells.find((x) => x.key === cell.key)
    if (ev && c) earlier.push({ entry, eval: ev, cell: c })
  }
  earlier.reverse()
  const runRef = (entry: HistoryEntry) => ({
    runId: entry.runId,
    sha: entry.git?.sha.slice(0, 12) ?? null,
    recorded: entry.recorded,
  })
  let since = run.runId
  for (const x of earlier) {
    if (!failedHere(x.cell)) break
    since = x.entry.runId
  }
  const clean = earlier.find((x) => !failedHere(x.cell) && x.cell.pass > 0)
  const previous = earlier[0]
  return {
    new: !previous || !failedHere(previous.cell),
    failingSince: since,
    lastPass: clean
      ? {
          ...runRef(clean.entry),
          changed: changedParts(cell, clean.cell),
          changedSources: changedSources(e.sources, clean.eval.sources),
        }
      : null,
    earlier: earlier.slice(0, 8).map((x) => ({
      ...runRef(x.entry),
      pass: x.cell.pass,
      fail: x.cell.fail,
      infraError: x.cell.infraError,
      sameFingerprint: x.cell.fingerprint === cell.fingerprint,
    })),
    earlierRuns: earlier.length,
  }
}

async function describeAttempt(
  config: ResolvedConfig,
  run: RunRecord,
  e: EvalEntry,
  a: AttemptRecord,
  tail: number,
) {
  const cell = e.cells.find((c) => c.key === a.cell)
  const lines = await transcriptLines(config, run, a)
  const failedChecks = await Promise.all(
    a.checks
      .filter((c) => c.exitCode !== 0)
      .map(async (c) => ({
        command: c.command,
        exitCode: c.exitCode,
        log: c.log?.path ?? null,
        logTail: await fileTail(config, run, c.log?.path, 1500),
      })),
  )
  const finalText = a.turns.findLast((t) => t.text)?.text ?? ''
  const failedAssertions = (a.assertions ?? [])
    .filter((x) => x.status !== 'pass')
    .map((x) => ({
      label: x.label,
      matcher: x.matcher,
      status: x.status,
      soft: x.soft,
      message: x.message ? clip(x.message, 800) : null,
    }))
  // An assertion error repeats its first failed assertion's message, which is already listed.
  const repeated =
    a.error?.kind === 'assertion' && a.assertions?.some((x) => x.message === a.error?.message)
  return {
    eval: e.id,
    attempt: a.key,
    cell: a.cell,
    harness: cell?.harness ?? null,
    environment: cell?.environment ?? null,
    outcome: a.outcome,
    gated: cell ? cell.gate !== 'none' : true,
    error: a.error
      ? { kind: a.error.kind, message: repeated ? null : clip(a.error.message, 1500) }
      : null,
    failedAssertions,
    failedJudgments: a.judgements
      .filter((j) => j.verdict === 'fail')
      .map((j) => ({ question: j.question, score: j.score, threshold: j.threshold })),
    failedChecks,
    turnErrors: a.turns.flatMap((t, i) => (t.error ? [{ turn: i + 1, error: t.error }] : [])),
    setupLogTail:
      a.outcome === 'infra_error'
        ? await fileTail(config, run, a.files.setupLog?.path, 1500)
        : null,
    changedFiles: a.changedFiles.slice(0, 30).map((f) => `${f.status} ${f.path}`),
    finalMessage: finalText ? clip(finalText, 800) : null,
    transcript: lines ? transcriptTail(lines, tail) : null,
    files: {
      transcript: a.files.transcript?.path ?? null,
      diff: a.files.diff?.path ?? null,
      setupLog: a.files.setupLog?.path ?? null,
    },
  }
}

const rank = (e: EvalEntry, a: AttemptRecord) => {
  const gated = e.cells.find((c) => c.key === a.cell)?.gate !== 'none'
  return (a.outcome === 'fail' ? 0 : 1) + (gated ? 0 : 2)
}

export async function failuresView(
  config: ResolvedConfig,
  options: { run?: string; filter?: string; limit?: number; tail?: number } = {},
) {
  const entries = await allRuns(config)
  const entry = resolveRun(entries, options.run)
  const dir = entry.recorded ? config.history.dir : scratchDir(config.root)
  const run = await readRecord(join(dir, `${entry.runId}.json`))
  const needle = options.filter?.toLowerCase()
  const failing = run.evals
    .filter((e) => !needle || e.id.toLowerCase().includes(needle))
    .flatMap((e) =>
      e.attempts
        .filter((a) => a.outcome === 'fail' || a.outcome === 'infra_error')
        .map((a) => ({ e, a })),
    )
    .sort((x, y) => rank(x.e, x.a) - rank(y.e, y.a))
  const limit = options.limit ?? DEFAULT_FAILURES
  const shown = failing.slice(0, limit)
  const histories = new Map<string, ReturnType<typeof cellHistory>>()
  const cells = shown.flatMap(({ e, a }) => {
    const id = `${e.key}\0${a.cell}`
    const cell = e.cells.find((c) => c.key === a.cell)
    if (histories.has(id) || !cell) return []
    histories.set(id, cellHistory(entries, run, e, cell))
    return [{ eval: e.id, cell: a.cell, ...histories.get(id) }]
  })
  const attempts = await Promise.all(
    shown.map(({ e, a }) => describeAttempt(config, run, e, a, options.tail ?? DEFAULT_TAIL)),
  )
  const header = {
    runId: run.runId,
    recorded: entry.recorded,
    sha: run.git?.sha.slice(0, 12) ?? null,
    summary: run.summary,
  }
  if (failing.length === 0) {
    const latest = [...entries]
      .reverse()
      .find((x) => x.summary.fail + x.summary.infraError > 0 && x.runId !== run.runId)
    return {
      ...header,
      failing: 0,
      attempts: [],
      cells: [],
      note: `Nothing failed in ${run.runId}${needle ? ` matching "${options.filter}"` : ''}.${latest ? ` The latest run with a failure is ${latest.runId}: pass it as run.` : ''}`,
    }
  }
  return {
    ...header,
    failing: failing.length,
    shown: shown.length,
    attempts,
    cells,
    next: `For the whole story of one attempt, transcript { run: "${run.runId}", attempt }. compare { head: "${run.runId}" } diffs this run against its baseline; query_flaky_cells says whether a cell fails intermittently across runs.`,
  }
}
