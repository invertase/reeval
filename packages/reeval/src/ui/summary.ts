import { headToHeadLines, sampleReasons } from '../compare/pairs.ts'
import {
  answersLabel,
  checksLabel,
  contrastLines,
  gateLabel,
  liftLabel,
  undiscriminating,
  undiscriminatingLabel,
} from '../history/summary.ts'
import type {
  AttemptRecord,
  EvalEntry,
  FamilyRate,
  FamilyRecord,
  RunSummary,
} from '../history/types.ts'
import { attemptKey } from '../ids.ts'
import { cellContrast, effortLabel } from '../view/effort.ts'
import {
  caseLabel,
  familyCases,
  familyEffortLabel,
  familyHeadLabel,
  familyLiftLabel,
  familyRateLabel,
} from '../view/family.ts'
import {
  cellJudgeRates,
  cellUsage,
  collapsedJudgeLabel,
  judgeRatesLabel,
} from '../view/judgements.ts'
import { formatUsage, hasUngatedCells, isUngatedMiss } from '../view/model.ts'
import { type Colors, colors } from './colors.ts'
import type { EvalResult, ReevalEvent } from './events.ts'
import {
  attemptOutcome,
  failureLines,
  formatDuration,
  MISS_MARK,
  mark,
  type Outcome,
} from './format.ts'

type RunEnd = Extract<ReevalEvent, { type: 'run-end' }>
export type AttemptDir = (id: string, cell: string, n: number) => string

const FAILURE_LINES = 30

const KINDS: Array<{ title: string; test: (a: AttemptRecord, o: Outcome) => boolean }> = [
  { title: 'Judge failures', test: (a) => a.error?.kind === 'judge' },
  { title: 'Assertion failures', test: (a) => a.error?.kind === 'assertion' },
  { title: 'Timeouts', test: (a) => a.error?.kind === 'timeout' },
  { title: 'Infra errors', test: (_, o) => o === 'infra_error' },
  { title: 'Cancelled', test: (_, o) => o === 'cancelled' },
]

/** The engine's result for an attempt, or one rebuilt from the record (e.g. cancelled ones). */
export function resultFor(entry: EvalEntry, attempt: AttemptRecord, results: EvalResult[]) {
  const key = attemptKey(entry.id, attempt.cell, attempt.n)
  const found = results.find((r) => r.key === key)
  const errorKind = attempt.error?.kind ?? null
  const meta = {
    outcome: attempt.outcome === 'skipped' ? ('pass' as const) : attempt.outcome,
    errorKind,
    judgements: attempt.judgements.map((j) => ({ ...j })),
    turnErrors: attempt.turns.flatMap((t, i) =>
      t.error ? [`turn ${i + 1} error: ${t.error}`] : [],
    ),
    recordPath: '',
  }
  if (found) return { ...found, meta: found.meta ? { ...found.meta, errorKind } : meta }
  const result: EvalResult = {
    id: entry.id,
    key,
    file: entry.file,
    group: entry.group,
    name: entry.name,
    attempt: undefined,
    state:
      attempt.outcome === 'pass' ? 'passed' : attempt.outcome === 'skipped' ? 'skipped' : 'failed',
    durationMs: attempt.durationMs,
    errors: attempt.error ? [attempt.error.message] : [],
    formattedErrors: [],
    meta,
  }
  return result
}

function entryOutcome(e: EvalEntry): Outcome {
  const outcomes = e.attempts.map(attemptOutcome)
  if (outcomes.length && outcomes.every((o) => o === 'cancelled')) return 'cancelled'
  return e.outcome
}

const pct = (rate: number | null) =>
  rate === null ? '  – ' : `${Math.round(rate * 100)}%`.padStart(4)

function evalColumns(c: Colors, e: EvalEntry): string {
  const [attempt, ...more] = e.attempts
  if (e.todo) return c.dim('todo')
  if (!attempt || e.outcome === 'skipped') return c.dim('skipped')
  if (more.length) {
    const pass = e.attempts.filter((a) => a.outcome === 'pass').length
    const counted = e.attempts.filter((a) => a.outcome === 'pass' || a.outcome === 'fail').length
    const rate = hasUngatedCells(e.cells)
      ? ` · pass@1 ${pct(e.passRate).trim()} gated`
      : `  pass@1 ${pct(e.passRate)}`
    return c.dim(`${`${pass}/${counted}`.padStart(7)}${rate}  ${e.attempts.length} attempts`)
  }
  if (attemptOutcome(attempt) === 'cancelled') return c.yellow('cancelled')
  const cols = [formatDuration(attempt.durationMs).padStart(7)]
  const judges = collapsedJudgeLabel(attempt.judgements)
  if (judges) cols.push(judges)
  const turns = attempt.turns.length
  cols.push(`${turns} turn${turns === 1 ? '' : 's'}`)
  const tokens = formatUsage(attempt.usage)
  if (tokens) cols.push(tokens)
  return c.dim(cols.join('  '))
}

/** pass@1 per cell for evals with several attempts; with compare, each cell's role and lift. */
function cellRows(c: Colors, e: EvalEntry, indent: string): string[] {
  if (e.attempts.length < 2) return []
  const compare = e.cells.some((cell) => cell.role === 'variant')
  const width = Math.max(...e.cells.map((cell) => cell.key.length))
  return e.cells.flatMap((cell) => {
    const role = compare ? `  ${cell.role.padEnd(7)}` : ''
    const counts = `${cell.pass}/${cell.pass + cell.fail}`.padStart(5)
    const infra = cell.infraError ? c.yellow(`   ${cell.infraError} infra`) : ''
    let note = ''
    if (cell.lift) {
      const { minLift } = cell.lift
      const below = minLift !== undefined && cell.lift.interval.lo < minLift
      const text = `${liftLabel(cell.lift)}${minLift !== undefined ? ` (minLift ${Math.round(minLift * 100)})` : ''}`
      note = `   ${below ? c.red(`${text} ✗`) : text}`
    } else if (compare && cell.gate === 'none' && cell.fail > 0) note = `   ${c.dim('not gated')}`
    if (cell.gate !== 'all' && cell.gate !== 'none')
      note += `   ${c.dim(`gate ${gateLabel(cell.gate)}`)}`
    const tokens = formatUsage(cellUsage(e, cell.key))
    const usage = tokens ? `   ${c.dim(tokens)}` : ''
    const rows = [
      `${indent}${c.dim(cell.key.padEnd(width))}${role}  ${counts}  pass@1 ${pct(cell.passRate)}${note}${infra}${usage}`,
    ]
    const rates = judgeRatesLabel(cellJudgeRates(e, cell.key))
    if (rates) rows.push(`${indent}  ${c.dim(rates)}`)
    const effort = cellContrast(e, cell.key)
    if (effort) rows.push(`${indent}  ${c.dim(`effort: ${effortLabel(effort)}`)}`)
    const checks = checksLabel(cell)
    if (checks) rows.push(`${indent}  ${c.dim(`checks: ${checks}`)}`)
    if (cell.overrides.length) {
      rows.push(`${indent}  ${c.dim(`overrides: ${cell.overrides.join(', ')}`)}`)
    }
    return rows
  })
}

/** With two variants or more, each pair of arms on one harness: lift, checks and effort. */
function contrastRows(c: Colors, e: EvalEntry, indent: string): string[] {
  const lines = contrastLines(e)
  if (!lines.length) return []
  return [
    `${indent}${c.dim('contrasts (each pair of arms, same harness)')}`,
    ...lines.map((line) => `${indent}  ${c.dim(line)}`),
  ]
}

/** One row per compare question: its win rates, or why it has none. They never gate. */
function questionRows(c: Colors, e: EvalEntry, indent: string): string[] {
  return (e.answers ?? []).flatMap((a) => {
    const label = answersLabel(a)
    const head = `${indent}${c.dim('question')}  ${a.error !== undefined ? c.yellow(label) : label}`
    return [
      head,
      ...headToHeadLines(a.votes).map((line) => `${indent}  ${line}`),
      ...sampleReasons(a.votes).map((reason) => `${indent}  ${c.dim(reason)}`),
    ]
  })
}

/** A family's mark: its pooled gate's and its cases' worst. */
function familyOutcome(family: FamilyRecord, cases: EvalEntry[]): Outcome {
  const outcomes = [family.outcome, ...cases.map(entryOutcome)]
  for (const o of ['fail', 'infra_error', 'cancelled'] as const) if (outcomes.includes(o)) return o
  return outcomes.every((o) => o === 'skipped') ? 'skipped' : 'pass'
}

/** The width case marks wrap at. */
const CASE_WIDTH = 96

/** A pooled family's rows under its header: its cases' marks, then each pooled rate or lift. */
function familyRows(c: Colors, family: FamilyRecord, cases: EvalEntry[], indent: string): string[] {
  const marks = cases.map((e) => `${mark(c, entryOutcome(e))} ${caseLabel(family.name, e.name)}`)
  const plain = cases.map((e) => `x ${caseLabel(family.name, e.name)}`)
  const rows: string[] = []
  let line: string[] = []
  let width = 0
  marks.forEach((m, i) => {
    const w = (plain[i] as string).length + 2
    if (line.length && width + w > CASE_WIDTH) {
      rows.push(`${indent}${line.join('  ')}`)
      line = []
      width = 0
    }
    line.push(m)
    width += w
  })
  if (line.length) rows.push(`${indent}${line.join('  ')}`)
  if (family.lifts.length) {
    const keyWidth = Math.max(...family.lifts.map((l) => l.variant.length))
    for (const lift of family.lifts) {
      const below = lift.outcome === 'fail'
      const gate =
        lift.minLift !== undefined
          ? ` (minLift ${Math.round(lift.minLift * 100)}${below ? ' ✗' : ''})`
          : ''
      const text = `${familyLiftLabel(lift)}${gate}`
      rows.push(`${indent}${c.dim(lift.variant.padEnd(keyWidth))}  ${below ? c.red(text) : text}`)
      const effort = familyEffortLabel(lift)
      if (effort) rows.push(`${indent}  ${c.dim(`effort: ${effort}`)}`)
    }
  } else if (family.rates.length === 1) {
    rows.push(`${indent}${familyRateLabel(family.rates[0] as FamilyRate)}`)
  } else {
    const keyWidth = Math.max(...family.rates.map((r) => r.cell.length))
    for (const rate of family.rates) {
      rows.push(`${indent}${c.dim(rate.cell.padEnd(keyWidth))}  ${familyRateLabel(rate)}`)
    }
  }
  return rows
}

/**
 * The run's evals as a file › group tree, one row per eval and per cell of a matrix. A pooled
 * family is one row, its template, with its cases' marks and the pooled results under it.
 */
function tree(c: Colors, evals: EvalEntry[], families: FamilyRecord[] = []): string[] {
  type Row = { indent: number; text: string; entry?: EvalEntry; family?: FamilyRecord }
  const rows: Row[] = []
  const shown = new Set<string>()
  let path: string[] = []
  for (const e of evals) {
    const family = e.family && families.find((f) => f.id === e.family?.id)
    if (family && shown.has(family.id)) continue
    const next = [e.file, ...e.group]
    let same = 0
    while (same < path.length && same < next.length && path[same] === next[same]) same++
    for (let i = same; i < next.length; i++) {
      rows.push({ indent: i, text: i === 0 ? c.bold(next[i] ?? '') : (next[i] ?? '') })
    }
    path = next
    if (family) {
      shown.add(family.id)
      rows.push({ indent: next.length, text: family.name, family })
    } else rows.push({ indent: next.length, text: e.name, entry: e })
  }
  const width = Math.max(
    ...rows.filter((r) => r.entry || r.family).map((r) => r.indent * 2 + 2 + r.text.length),
  )
  return rows.flatMap(({ indent, text, entry, family }) => {
    const pad = '  '.repeat(indent)
    const fill = ' '.repeat(Math.max(0, width - indent * 2 - 2 - text.length))
    if (family) {
      const cases = familyCases(family, evals)
      return [
        ` ${pad}${mark(c, familyOutcome(family, cases))} ${text}${fill}  ${c.dim(familyHeadLabel(family))}`,
        ...familyRows(c, family, cases, ` ${pad}    `),
      ]
    }
    if (!entry) return [` ${pad}${text}`]
    const name = `${mark(c, entryOutcome(entry))} ${text}`
    return [
      ` ${pad}${name}${fill}  ${evalColumns(c, entry)}`,
      ...cellRows(c, entry, ` ${pad}    `),
      ...contrastRows(c, entry, ` ${pad}    `),
      ...questionRows(c, entry, ` ${pad}    `),
    ]
  })
}

export function totals(c: Colors, s: RunSummary, cancelled = 0): string {
  const fail = s.fail - s.notGated - cancelled
  const parts = [
    s.pass && c.green(`${s.pass} passed`),
    fail > 0 && c.red(`${fail} failed`),
    s.notGated > 0 && c.dim(`${s.notGated} missed, not gated`),
    s.infraError && c.yellow(`${s.infraError} infra error`),
    cancelled && c.yellow(`${cancelled} cancelled`),
    s.skipped && c.dim(`${s.skipped} skipped`),
  ].filter(Boolean)
  const scope = s.attempts === s.evals ? `${s.evals}` : `${s.attempts} attempts, ${s.evals} evals`
  return parts.length ? `${parts.join(c.dim(' · '))} ${c.dim(`(${scope})`)}` : 'no evals ran'
}

/** `1 passed · 1 failed (2)`: the families' pooled gates. */
export function familyTotals(c: Colors, families: FamilyRecord[]): string {
  const fail = families.filter((f) => f.outcome === 'fail').length
  const pass = families.length - fail
  const parts = [pass && c.green(`${pass} passed`), fail && c.red(`${fail} failed`)].filter(Boolean)
  return `${parts.join(c.dim(' · '))} ${c.dim(`(${families.length})`)}`
}

/** Failing attempts, in run order, including expected misses. */
export function failingAttempts(evals: EvalEntry[]) {
  return evals.flatMap((entry) =>
    entry.attempts
      .map((attempt) => ({ entry, attempt, outcome: attemptOutcome(attempt) }))
      .filter(({ outcome }) => outcome !== 'pass' && outcome !== 'skipped'),
  )
}

export function renderSummary(c: Colors, e: RunEnd, attemptDir: AttemptDir): string[] {
  const { record } = e
  const lines: string[] = []
  if (record.evals.length) {
    lines.push(c.bold('Summary'), ...tree(c, record.evals, record.families))
  }

  const all = failingAttempts(record.evals)
  const missed = all.filter(({ entry, attempt }) => isUngatedMiss(entry, attempt))
  const failing = all.filter((f) => !missed.includes(f))
  if (failing.length) {
    lines.push('', c.bold(c.red(`Failures (${failing.length})`)))
    for (const kind of KINDS) {
      const members = failing.filter(({ attempt, outcome }) => kind.test(attempt, outcome))
      if (!members.length) continue
      lines.push('', c.bold(`${kind.title} (${members.length})`))
      for (const { entry, attempt, outcome } of members) {
        const result = resultFor(entry, attempt, e.results)
        const which = entry.attempts.length > 1 ? `  ${c.dim(attempt.id)}` : ''
        const gated = entry.cells.find((x) => x.key === attempt.cell)?.gate !== 'none'
        lines.push(
          ` ${mark(c, outcome)} ${entry.id}${which}${gated ? '' : `  ${c.dim('(not gated)')}`}`,
        )
        if (outcome !== 'cancelled') {
          for (const line of failureLines(c, result, { max: FAILURE_LINES }))
            lines.push(`   ${line}`)
        }
        if (!attempt.error?.prepare) {
          lines.push(`   ${c.dim('record')}  ${attemptDir(entry.id, attempt.cell, attempt.n)}`)
        }
      }
    }
  }
  // Short on purpose: in a compare, the control missing is what the lift is measured against.
  if (missed.length) {
    lines.push('', c.bold(`Expected misses, not gated (${missed.length})`))
    // A pooled family's misses are one line per cell: the pooled line above says what they mean.
    const pooled = new Map<string, number>()
    for (const { entry, attempt } of missed) {
      if (!entry.family) continue
      const key = `${entry.family.id}\0${attempt.cell}`
      pooled.set(key, (pooled.get(key) ?? 0) + 1)
    }
    for (const [key, n] of pooled) {
      const [id, cell] = key.split('\0')
      lines.push(
        ` ${MISS_MARK(c)} ${id}  ${c.dim(`${n} ${n === 1 ? 'attempt' : 'attempts'} on ${cell}`)}`,
      )
    }
    for (const { entry, attempt } of missed) {
      if (entry.family) continue
      const which = entry.attempts.length > 1 ? `  ${c.dim(attempt.id)}` : ''
      const [reason] = failureLines(colors(false), resultFor(entry, attempt, e.results), {
        max: 1,
      }).filter((l) => l.trim())
      lines.push(` ${MISS_MARK(c)} ${entry.id}${which}`)
      if (reason) lines.push(`   ${c.dim(reason.trim())}`)
      lines.push(`   ${c.dim('record')}  ${attemptDir(entry.id, attempt.cell, attempt.n)}`)
    }
  }

  for (const error of e.unhandledErrors) lines.push('', c.red(`error: ${error}`))

  const cancelled = failing.filter((f) => f.outcome === 'cancelled').length
  const label = record.summary.attempts === record.summary.evals ? '   Evals' : 'Attempts'
  const lifted = record.evals.flatMap((entry) =>
    entry.cells.flatMap((cell) =>
      cell.lift?.minLift !== undefined && cell.lift.interval.lo < cell.lift.minLift
        ? [
            `${entry.id}  ${cell.key} ${liftLabel(cell.lift)}: its lower bound is below minLift ${Math.round(cell.lift.minLift * 100)}`,
          ]
        : [],
    ),
  )
  for (const family of record.families ?? []) {
    for (const lift of family.lifts) {
      if (lift.outcome !== 'fail' || lift.minLift === undefined) continue
      lifted.push(
        `${family.id}  ${lift.variant} pooled ${familyLiftLabel(lift)}: its lower bound is below minLift ${Math.round(lift.minLift * 100)}`,
      )
    }
  }
  const idle = undiscriminating(record.evals)
  if (idle.length) {
    lines.push('', c.bold(`Checks that don't discriminate (${idle.length})`))
    for (const x of idle) lines.push(` ${c.dim('·')} ${undiscriminatingLabel(x)}`)
  }
  if (lifted.length) {
    lines.push('', c.bold(c.red(`Lift below minLift (${lifted.length})`)))
    for (const line of lifted) lines.push(` ${c.red('✗')} ${line}`)
  }
  if (record.status === 'budget') {
    lines.push('', c.yellow('Budget reached: attempts that hadn’t started were skipped'))
  }
  lines.push('')
  if (record.families?.length)
    lines.push(`${c.dim('Families')}  ${familyTotals(c, record.families)}`)
  lines.push(
    `${c.dim(label)}  ${totals(c, record.summary, cancelled)}`,
    `${c.dim('Duration')}  ${formatDuration(record.durationMs)}`,
  )
  const tokens = formatUsage(record.cost.usage)
  if (tokens) lines.push(`  ${c.dim('Tokens')}  ${tokens}`)
  lines.push(` ${c.dim('Results')}  ${e.summaryPath}`)
  return lines
}
