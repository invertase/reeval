import type { EvalEntry } from '../history/types.ts'
import type { Colors } from './colors.ts'
import type { EsEvent, EvalResult } from './events.ts'
import { entryOutcome, failureLines, formatDuration, mark, type Outcome, totals } from './format.ts'

type RunEnd = Extract<EsEvent, { type: 'run-end' }>

const FAILURE_LINES = 30

const KINDS: Array<{ title: string; test: (e: EvalEntry, o: Outcome) => boolean }> = [
  { title: 'Judge failures', test: (e) => e.attempts[0]?.error?.kind === 'judge' },
  { title: 'Assertion failures', test: (e) => e.attempts[0]?.error?.kind === 'assertion' },
  { title: 'Timeouts', test: (e) => e.attempts[0]?.error?.kind === 'timeout' },
  { title: 'Infra errors', test: (_, o) => o === 'infra_error' },
  { title: 'Cancelled', test: (_, o) => o === 'cancelled' },
]

/** The engine's result for an entry, or one rebuilt from the record (e.g. cancelled evals). */
export function resultFor(entry: EvalEntry, results: EvalResult[]): EvalResult {
  const found = results.find((r) => r.id === entry.id)
  const attempt = entry.attempts[0]
  const errorKind = attempt?.error?.kind ?? null
  const meta = {
    outcome: entry.outcome === 'skipped' ? ('pass' as const) : entry.outcome,
    errorKind,
    judgements: (attempt?.judgements ?? []).map((j) => ({ ...j })),
    recordPath: '',
  }
  if (found) return { ...found, meta: found.meta ? { ...found.meta, errorKind } : meta }
  return {
    id: entry.id,
    file: entry.file,
    group: entry.group,
    name: entry.name,
    state: entry.outcome === 'pass' ? 'passed' : entry.outcome === 'skipped' ? 'skipped' : 'failed',
    durationMs: attempt?.durationMs ?? 0,
    errors: attempt?.error ? [attempt.error.message] : [],
    formattedErrors: [],
    meta,
  }
}

function evalColumns(c: Colors, e: EvalEntry): string {
  const attempt = e.attempts[0]
  if (!attempt || e.outcome === 'skipped') return c.dim('skipped')
  if (entryOutcome(e) === 'cancelled') return c.yellow('cancelled')
  const cols = [formatDuration(attempt.durationMs).padStart(7)]
  const scores = attempt.judgements.map((j) => j.score)
  if (scores.length) cols.push(`judge ${Math.min(...scores).toFixed(2)}`)
  const turns = attempt.turns.length
  cols.push(`${turns} turn${turns === 1 ? '' : 's'}`)
  return c.dim(cols.join('  '))
}

/** The run's evals as a file › group tree, one row per eval. */
function tree(c: Colors, evals: EvalEntry[]): string[] {
  const rows: Array<{ indent: number; text: string; entry?: EvalEntry }> = []
  let path: string[] = []
  for (const e of evals) {
    const next = [e.file, ...e.group]
    let same = 0
    while (same < path.length && same < next.length && path[same] === next[same]) same++
    for (let i = same; i < next.length; i++) {
      rows.push({ indent: i, text: i === 0 ? c.bold(next[i] ?? '') : (next[i] ?? '') })
    }
    path = next
    rows.push({ indent: next.length, text: e.name, entry: e })
  }
  const width = Math.max(
    ...rows.filter((r) => r.entry).map((r) => r.indent * 2 + 2 + r.text.length),
  )
  return rows.map(({ indent, text, entry }) => {
    const pad = '  '.repeat(indent)
    if (!entry) return ` ${pad}${text}`
    const name = `${mark(c, entryOutcome(entry))} ${text}`
    const fill = ' '.repeat(Math.max(0, width - indent * 2 - 2 - text.length))
    return ` ${pad}${name}${fill}  ${evalColumns(c, entry)}`
  })
}

export function renderSummary(
  c: Colors,
  e: RunEnd,
  attemptDir: (id: string, attempt: number) => string,
): string[] {
  const { record } = e
  const lines: string[] = []
  if (record.evals.length) lines.push(c.bold('Summary'), ...tree(c, record.evals))

  const failing = record.evals
    .map((entry) => ({ entry, outcome: entryOutcome(entry) }))
    .filter(({ outcome }) => outcome !== 'pass' && outcome !== 'skipped')
  if (failing.length) {
    lines.push('', c.bold(c.red(`Failures (${failing.length})`)))
    for (const kind of KINDS) {
      const members = failing.filter(({ entry, outcome }) => kind.test(entry, outcome))
      if (!members.length) continue
      lines.push('', c.bold(`${kind.title} (${members.length})`))
      for (const { entry, outcome } of members) {
        const result = resultFor(entry, e.results)
        const reasons = (entry.attempts[0]?.judgements ?? [])
          .filter((j) => j.verdict !== 'pass')
          .map((j) => j.reason)
        lines.push(` ${mark(c, outcome)} ${entry.id}`)
        if (outcome !== 'cancelled') {
          for (const line of failureLines(c, result, { max: FAILURE_LINES, reasons }))
            lines.push(`   ${line}`)
        }
        lines.push(`   ${c.dim('record')}  ${attemptDir(entry.id, entry.attempts[0]?.n ?? 1)}`)
      }
    }
  }

  for (const error of e.unhandledErrors) lines.push('', c.red(`error: ${error}`))

  const cancelled = failing.filter((f) => f.outcome === 'cancelled').length
  lines.push(
    '',
    `   ${c.dim('Evals')}  ${totals(c, record.summary, cancelled)}`,
    `${c.dim('Duration')}  ${formatDuration(record.durationMs)}`,
  )
  if (record.cost.usd !== null) lines.push(`    ${c.dim('Cost')}  $${record.cost.usd.toFixed(2)}`)
  lines.push(` ${c.dim('Results')}  ${e.summaryPath}`)
  return lines
}
