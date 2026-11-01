// `reeval run`'s results as a status list: one row per eval, grouped under its file, each with an
// icon, its name and `N of M runs passed`, and a detail of plain sentences from the record. The
// sentences come from fixed templates (no model), so the same run always reads the same:
//
// - Outcome, per harness (with the environment or sandbox when the eval has several):
//   one harness reads `Passed on H every time.`, `Failed on H every time.` or `Passed N of M on H.`;
//   several read `Passed on A and B every time.` when every run passed, `Failed on A and B every
//   time.` when none did, else `A passed N of M, B N of M.`
// - A compare reads `Baseline <arm> passed N of M.`, then `Variants, by pass rate:` with one line per
//   variant, highest pass rate first, naming the harnesses only where their pass rates differ, and
//   `, not by minLift N` after the effect when the variant's lift (a family's pooled one) missed it.
// - A family whose cases didn't all pass names them: `Failed cases: green, blue.` (the first eight,
//   then `and N more`).
// - Failed checks: `Every failure was the same check:` for one, `N checks failed:` for several,
//   each `"label" failed N times`, then its first message and `at file:line`. With one harness
//   nothing more; else `, all on H` when every failure was on H, `, M of them on H` when H had
//   more than half of them, and nothing when no harness did. A compare counts every arm's runs
//   and tells them apart by arm (`the baseline` or the variant) instead of by harness.
// - `Worth knowing:` the eval's remarks, one line each, then each check that needed its retries
//   (`"label" passed on try 2 of 3.`) and the first capture whose page had errors
//   (`2 page errors in capture "home" → <file>`, with `(+N more captures)`).
//
// Only the cells that decide the outcome count: the gated ones, or every cell of a study.
import type { RunRecord } from '../history/types.ts'
import { clip, formatDuration, plural } from '../text.ts'
import type { ErrorKind } from '../types.ts'
import { formatUsage } from '../view/model.ts'
import type { Remark, RunRemarks } from '../view/remarks.ts'
import {
  type CellResult,
  type CheckResult,
  countedOf,
  type Effect,
  type EvalResult,
  effectOf,
  isNotGatedResult,
  type SuiteResult,
} from '../view/suite.ts'
import { checkLabel } from './layout.ts'
import { shownRemarks } from './remarks.ts'

export type StatusIcon = 'queued' | 'running' | 'pass' | 'fail' | 'observe' | 'skipped' | 'canceled'

/** A detail line: its depth under the row, and how it's painted. */
export type DetailLine = {
  depth: 0 | 1 | 2
  text: string
  tone?: 'dim' | 'red' | 'heading'
}

export type StatusRow = {
  /** The eval's id, or the family's. */
  id: string
  name: string
  icon: StatusIcon
  /** `3 of 4 runs passed`, `2 of 4 runs done`, `skipped`. */
  summary: string
  detail: DetailLine[]
  /** It has remarks, under `Worth knowing:`, which a list printed once shows even on a pass. */
  remarks: number
  /** A compare, whose detail (the baseline and its variants) a list printed once always shows. */
  compare: boolean
}

export type StatusFile = { path: string; rows: StatusRow[] }

export type StatusList = {
  files: StatusFile[]
  /** Errors outside any eval: an eval file that didn't load, a stray rejection. */
  errors: string[]
  /** `Done in 1m 05s · 3 passed · 1 failed · 232k in · 3,026 out`. */
  done: string
  /** Incomplete, budget and interrupted notes, then where the results are. */
  notes: string[]
  /** Concerns the cap left out of the eval details. */
  hiddenRemarks: number
}

const EFFECT: Record<Effect, string> = { better: 'helped', worse: 'made it worse', same: 'same' }

const ERROR_VERB: Record<ErrorKind | 'turn', string> = {
  assertion: 'failed',
  timeout: 'timed out',
  aborted: 'canceled',
  infra: 'hit an infrastructure error',
  judge: 'could not be judged',
  turn: 'ended a turn with an error',
}

const MESSAGE_LINES = 4
const LINE_MAX = 160

const times = (n: number) => (n === 1 ? 'once' : `${n} times`)

/** `cursor (composer-2.5)`, from the record's cell. */
function harnessLabel(record: RunRecord, cell: CellResult): string {
  const model = record.evals
    .flatMap((e) => e.cells)
    .find((c) => c.key === cell.key && c.harness === cell.harness)?.model
  return model && model !== cell.harness ? `${cell.harness} (${model})` : cell.harness
}

/** The cells an eval's outcome reads: the gated ones, or every cell of a study. */
function deciding(cells: CellResult[]): CellResult[] {
  const gated = cells.filter((c) => c.gated)
  return gated.length ? gated : cells
}

const cellsOf = (e: EvalResult): CellResult[] => e.cells ?? (e.cases ?? []).flatMap((k) => k.cells)

/** Each part's label, adding the environment and sandbox only where the cells differ in them. */
function labeler(record: RunRecord, cells: CellResult[]) {
  const envs = new Set(cells.map((c) => c.environment)).size > 1
  const sandboxes = new Set(cells.map((c) => c.sandbox)).size > 1
  return (c: CellResult) =>
    [harnessLabel(record, c), envs ? `in ${c.environment}` : '', sandboxes ? `on ${c.sandbox}` : '']
      .filter(Boolean)
      .join(' ')
}

type Tally = { label: string; passed: number; counted: number }

function tallyBy(cells: CellResult[], label: (c: CellResult) => string): Tally[] {
  const by = new Map<string, Tally>()
  for (const c of cells) {
    const key = label(c)
    const t = by.get(key) ?? { label: key, passed: 0, counted: 0 }
    t.passed += c.passed
    t.counted += countedOf(c)
    by.set(key, t)
  }
  return [...by.values()]
}

const of = (t: Pick<Tally, 'passed' | 'counted'>) => `${t.passed} of ${t.counted}`

/** The outcome sentence, per the rules at the top. */
function outcomeSentence(tallies: Tally[]): string {
  const counted = tallies.filter((t) => t.counted > 0)
  if (!counted.length) return 'No run finished.'
  const [one] = counted
  if (counted.length === 1 && one) {
    const once = one.counted === 1
    if (one.passed === one.counted) return `Passed on ${one.label}${once ? '' : ' every time'}.`
    if (one.passed === 0) return `Failed on ${one.label}${once ? '' : ' every time'}.`
    return `Passed ${of(one)} on ${one.label}.`
  }
  const names = counted.map((t) => t.label)
  const all = `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  if (counted.every((t) => t.passed === t.counted)) return `Passed on ${all} every time.`
  if (counted.every((t) => t.passed === 0)) return `Failed on ${all} every time.`
  const [first, ...rest] = counted
  return `${first?.label} passed ${first ? of(first) : ''}${rest.map((t) => `, ${t.label} ${of(t)}`).join('')}.`
}

/** `(cursor 4 of 4, codex 1 of 4)` when the harnesses' pass rates differ; empty when they agree. */
function disagreement(record: RunRecord, cells: CellResult[]): string {
  const tallies = tallyBy(cells, (c) => harnessLabel(record, c)).filter((t) => t.counted > 0)
  if (tallies.length < 2) return ''
  const rates = new Set(tallies.map((t) => t.passed / t.counted))
  return rates.size > 1 ? ` (${tallies.map((t) => `${t.label} ${of(t)}`).join(', ')})` : ''
}

/** `, not by minLift 60` when the variant's lift fell short of its `minLift`, which fails it. */
function minLiftShort(e: EvalResult, own: CellResult[]): string {
  const keys = new Set(own.map((c) => c.key))
  const pooled = (e.pooled ?? []).filter((p) => keys.has(p.key))
  const missed = pooled.length
    ? pooled.find((p) => p.minLift !== null && p.outcome === 'fail')?.minLift
    : own.find((c) => c.minLift !== null && c.interval && c.interval.low < c.minLift)?.minLift
  return missed == null ? '' : `, not by minLift ${Math.round(missed * 100)}`
}

function compareLines(record: RunRecord, e: EvalResult, cells: CellResult[]): DetailLine[] {
  const base = cells.filter((c) => c.baseline)
  const name = (c: CellResult) => (c.environment === '-' ? 'no environment' : c.environment)
  const baseTally = tallyBy(base, () => 'baseline')[0] ?? { passed: 0, counted: 0 }
  const baseName = [...new Set(base.map(name))].join(', ')
  const lines: DetailLine[] = [
    {
      depth: 0,
      text: `Baseline ${baseName} passed ${of(baseTally)}${disagreement(record, base)}.`,
    },
  ]
  const variants = [...new Set(cells.filter((c) => c.variant !== null).map((c) => c.variant))]
  if (!variants.length) return lines
  const rows = variants.map((v, order) => {
    const own = cells.filter((c) => c.variant === v)
    const t = tallyBy(own, () => v ?? '')[0] ?? { passed: 0, counted: 0 }
    const effect = effectOf(
      { pass: t.passed, counted: t.counted },
      {
        pass: baseTally.passed,
        counted: baseTally.counted,
      },
    )
    return { v: v ?? '', t, effect, own, order }
  })
  const rate = (t: { passed: number; counted: number }) => (t.counted ? t.passed / t.counted : -1)
  rows.sort((a, b) => rate(b.t) - rate(a.t) || a.order - b.order)
  const width = Math.max(...rows.map((r) => r.v.length))
  lines.push({ depth: 0, text: 'Variants, by pass rate:', tone: 'heading' })
  for (const r of rows) {
    const short = minLiftShort(e, r.own)
    const word = r.effect ? `  ${EFFECT[r.effect]}${short}` : short ? `  ${short.slice(2)}` : ''
    lines.push({
      depth: 1,
      text: `${r.v.padEnd(width)}  ${of(r.t)}${word}${disagreement(record, r.own)}`,
    })
  }
  return lines
}

type FailedCheck = {
  label: string
  failed: number
  byHarness: Map<string, number>
  first: CheckResult
}

function failedChecks(cells: CellResult[], groupOf: (c: CellResult) => string): FailedCheck[] {
  const by = new Map<string, FailedCheck>()
  for (const cell of cells) {
    for (const k of cell.checks) {
      if (k.outcome.status !== 'ran' || k.outcome.failed + k.outcome.errored === 0) continue
      const n = k.outcome.failed + k.outcome.errored
      const f = by.get(k.label) ?? { label: k.label, failed: 0, byHarness: new Map(), first: k }
      f.failed += n
      const h = groupOf(cell)
      f.byHarness.set(h, (f.byHarness.get(h) ?? 0) + n)
      if (f.first.outcome.status === 'ran' && !f.first.outcome.assertion) f.first = k
      by.set(k.label, f)
    }
  }
  return [...by.values()].sort((a, b) => b.failed - a.failed || a.first.order - b.first.order)
}

/** `, all on H` or `, M of them on H`, per the rules at the top. */
function where(f: FailedCheck, harnesses: number): string {
  if (harnesses < 2) return ''
  const [top] = [...f.byHarness].sort((a, b) => b[1] - a[1])
  if (!top) return ''
  const [h, n] = top
  if (n === f.failed) return f.failed === 1 ? `, on ${h}` : `, all on ${h}`
  return n * 2 > f.failed ? `, ${n} of them on ${h}` : ''
}

/** A message's first lines, without the label it repeats or a command's empty output headings. */
function messageLines(text: string, label = '', max = LINE_MAX): string[] {
  const own = label && text.startsWith(`${label}: `) ? text.slice(label.length + 2) : text
  return own
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/^--- (stderr|stdout) ---$/.test(l.trim()))
    .slice(0, MESSAGE_LINES)
    .map((l) => clip(l, max))
}

/** A failure's message is red only on a failed eval: a passing compare's baseline misses are expected. */
function checkLines(
  cells: CellResult[],
  groupOf: (c: CellResult) => string,
  tone: 'red' | 'dim',
): DetailLine[] {
  const failed = failedChecks(cells, groupOf)
  if (!failed.length) return []
  const harnesses = new Set(cells.map(groupOf)).size
  const lines: DetailLine[] = [
    {
      depth: 0,
      text:
        failed.length === 1
          ? 'Every failure was the same check:'
          : `${failed.length} checks failed:`,
      tone: 'heading',
    },
  ]
  for (const f of failed) {
    lines.push({
      depth: 1,
      text: `"${checkLabel(f.label)}" failed ${times(f.failed)}${where(f, harnesses)}`,
    })
    const o = f.first.outcome
    const judge = f.first.judge
    const message =
      o.status === 'ran' && o.assertion
        ? o.assertion
        : judge
          ? `judge: ${judge.question} (scores ${judge.scores.join(', ')}, threshold ${judge.threshold})`
          : ''
    for (const text of messageLines(message, f.label)) lines.push({ depth: 2, text, tone })
    if (o.status === 'ran' && o.at) lines.push({ depth: 2, text: `at ${o.at}`, tone: 'dim' })
  }
  return lines
}

const CASES_NAMED = 8

function failedCaseLines(e: EvalResult): DetailLine[] {
  const failed = (e.cases ?? []).filter((k) => k.outcome !== 'pass' && k.outcome !== 'skipped')
  if (!failed.length) return []
  const named = failed.slice(0, CASES_NAMED).map((k) => k.label)
  const more = failed.length > CASES_NAMED ? ` and ${failed.length - CASES_NAMED} more` : ''
  return [{ depth: 0, text: `Failed cases: ${named.join(', ')}${more}.` }]
}

/** Errors no failed check explains: timeouts, infrastructure errors, throws. Never clipped: their remedy is often last. */
function errorLines(cells: CellResult[], tone: 'red' | 'dim'): DetailLine[] {
  const by = new Map<string, { kind: ErrorKind | 'turn'; message: string; n: number }>()
  for (const c of cells) {
    for (const err of c.errors) {
      const key = `${err.kind}\n${err.message}`
      const e = by.get(key) ?? { kind: err.kind, message: err.message, n: 0 }
      e.n += err.attempts
      by.set(key, e)
    }
  }
  return [...by.values()].flatMap((e) => [
    { depth: 0, text: `${plural(e.n, 'run')} ${ERROR_VERB[e.kind]}:`, tone: 'heading' } as const,
    ...messageLines(e.message, '', Number.POSITIVE_INFINITY).map(
      (text) => ({ depth: 1, text, tone }) as const,
    ),
  ])
}

/** `evals/a.eval.ts:12` from `source:evals/a.eval.ts#L12`. */
const location = (at: string) => at.replace(/^source:/, '').replace(/#L(\d+)$/, ':$1')

/** `"npm test" passed on try 2 of 3.`: a check that needed its `c.exec` retries is flaky. */
function retriedLines(cells: CellResult[]): string[] {
  const seen = new Set<string>()
  return cells.flatMap((c) =>
    c.checks.flatMap((k) => {
      if (!k.retried || seen.has(k.label)) return []
      seen.add(k.label)
      return [`"${checkLabel(k.label)}" ${k.retried}.`]
    }),
  )
}

function pageErrorNotes(cells: CellResult[]): string[] {
  const [first, ...rest] = cells.flatMap((c) => c.pageErrors ?? [])
  if (!first) return []
  const more = rest.length ? ` (+${plural(rest.length, 'more capture')})` : ''
  return [
    `${plural(first.errors, 'page error')} in capture "${first.capture}" → ${first.file}${more}`,
  ]
}

function remarkLines(remarks: Remark[], notes: string[]): DetailLine[] {
  if (!remarks.length && !notes.length) return []
  return [
    { depth: 0, text: 'Worth knowing:', tone: 'heading' },
    ...remarks.map((r) => ({
      depth: 1 as const,
      text: r.fix.edit
        ? `${r.text} Fix at ${location(r.fix.at)}: ${r.fix.edit}.`
        : `${r.text} At ${location(r.fix.at)}.`,
    })),
    ...notes.map((text) => ({ depth: 1 as const, text })),
  ]
}

/** A compare's failures are told apart by arm: `the baseline`, or the variant's name. */
const armOf = (c: CellResult) => (c.baseline ? 'the baseline' : (c.variant ?? c.environment))

const nameOf = (e: Pick<EvalResult, 'group' | 'name' | 'template'>) =>
  [...e.group, e.template ?? e.name].join(' › ')

function iconOf(e: EvalResult): StatusIcon {
  if (e.todo || e.notRun) return 'skipped'
  if (e.outcome === 'skipped') return 'skipped'
  if (e.outcome === 'canceled') return 'canceled'
  if (e.outcome === 'pass') return isNotGatedResult(e) ? 'observe' : 'pass'
  return 'fail'
}

export function evalRow(record: RunRecord, e: EvalResult, remarks: Remark[]): StatusRow {
  const cells = cellsOf(e)
  const decide = deciding(cells)
  const passed = decide.reduce((n, c) => n + c.passed, 0)
  const ran = decide.reduce((n, c) => n + c.passed + c.failed + c.infraError, 0)
  const summary = e.todo
    ? 'todo'
    : e.notRun
      ? 'not run'
      : ran === 0
        ? e.outcome === 'canceled'
          ? 'canceled'
          : 'skipped'
        : `${passed} of ${plural(ran, 'run')} passed`
  const compare = cells.some((c) => c.baseline)
  const tone = iconOf(e) === 'fail' ? 'red' : 'dim'
  const notes = ran ? [...retriedLines(decide), ...pageErrorNotes(decide)] : []
  const detail = ran
    ? [
        ...(compare
          ? compareLines(record, e, cells)
          : [
              {
                depth: 0,
                text: outcomeSentence(tallyBy(decide, labeler(record, decide))),
              } as const,
            ]),
        ...failedCaseLines(e),
        ...(compare
          ? checkLines(cells, armOf, tone)
          : checkLines(decide, (c) => harnessLabel(record, c), tone)),
        ...errorLines(compare ? cells : decide, tone),
        ...remarkLines(remarks, notes),
      ]
    : remarkLines(remarks, [])
  return {
    id: e.id,
    name: nameOf(e),
    icon: iconOf(e),
    summary,
    detail,
    remarks: remarks.length + notes.length,
    compare,
  }
}

/** `3 passed · 1 failed · 1 not gated`, from the suite's tally. */
export function tallyText(suite: SuiteResult): string {
  const t = suite.tally
  return [
    t.errors ? plural(t.errors, 'run error') : '',
    t.fail ? `${t.fail} failed` : '',
    t.infraError ? plural(t.infraError, 'infra error') : '',
    t.canceled ? `${t.canceled} canceled` : '',
    t.pass ? `${t.pass} passed` : '',
    t.notGated ? `${t.notGated} not gated` : '',
    t.skipped ? `${t.skipped} skipped` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

export type ListInput = {
  record: RunRecord
  suite: SuiteResult
  remarks: RunRemarks | null
  verbose: boolean
  /** Attempts the run planned that this resume's filters left out. */
  notRun?: number
}

export function statusList(input: ListInput): StatusList {
  const { record, suite } = input
  const { shown, hidden } = shownRemarks(input.remarks?.remarks ?? [], suite.runId, input.verbose)
  const files = suite.files.map((f) => ({
    path: f.path,
    rows: f.evals.map((e) =>
      evalRow(
        record,
        e,
        shown.filter((r) => r.evalId === e.path),
      ),
    ),
  }))
  const tokens = formatUsage(record.cost.usage)
  const done = [
    `Done in ${formatDuration(record.durationMs)}`,
    tallyText(suite) || 'nothing ran',
    tokens,
  ]
    .filter(Boolean)
    .join(' · ')
  const notes = [
    ...(input.notRun
      ? [
          `Incomplete: ${plural(input.notRun, 'attempt')} this resume’s filters left out ${input.notRun === 1 ? 'is' : 'are'} not run; reeval run --resume ${record.runId} runs ${input.notRun === 1 ? 'it' : 'them'}`,
        ]
      : []),
    ...(record.status === 'budget' && !input.notRun
      ? ['Budget reached: attempts that hadn’t started were skipped']
      : []),
    ...(record.status === 'interrupted' && !input.notRun
      ? ['Interrupted: attempts that hadn’t finished were canceled']
      : []),
  ]
  return { files, errors: suite.errors, done, notes, hiddenRemarks: hidden }
}

/** The pointers under the closing line: the studio and the run's summary.md. */
export const pointerLine = (summaryPath: string) =>
  `Browse it: reeval studio · summary ${summaryPath}`
