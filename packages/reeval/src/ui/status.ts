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
//   With `-v`, each of its cells' difference and 95% interval follows, as the result blocks print it.
//   Under a variant, its comparison with the baseline when some other measure holds:
//   `Same pass rate · 5× faster · judge "tidy" +0.12.` (with `-v`, `looks …` for the leans too),
//   prefixed `H: ` on several harnesses.
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
import { measuresLine } from '../view/measures.ts'
import { formatUsage } from '../view/model.ts'
import { type ObservedTally, observedLine } from '../view/observations.ts'
import type { Remark, RunRemarks } from '../view/remarks.ts'
import {
  type AttemptQuestionResult,
  type CellResult,
  type CheckResult,
  countedOf,
  type Effect,
  type EvalResult,
  effectOf,
  isNotGatedResult,
  type QuestionResult,
  type SuiteResult,
} from '../view/suite.ts'
import { checkLabel, statsLine } from './layout.ts'
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
  /** `3 of 4 runs passed`, `8 of 8 variant runs passed` (a gated compare's baseline doesn't count), `2 of 4 runs done`, `skipped`. */
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

/**
 * Under a variant, its comparison with the baseline (`measuresLine`): `Same pass rate · 5× faster ·
 * judge "tidy" +0.12.`, one line, or one per harness (`cursor: …`) when it ran on several. Only
 * when some measure besides pass rate holds; `verbose` adds the ones that only lean.
 */
function measureLines(e: EvalResult, own: CellResult[], verbose: boolean): DetailLine[] {
  const keys = new Set(own.map((c) => c.key))
  const pooled = (e.pooled ?? []).filter((p) => keys.has(p.key))
  const sets = pooled.length
    ? pooled.map((p) => ({ harness: '', measures: p.measures }))
    : own.flatMap((c) => (c.measures ? [{ harness: c.harness, measures: c.measures }] : []))
  const several = new Set(sets.map((x) => x.harness)).size > 1
  return sets.flatMap(({ harness, measures }) => {
    const shown = measures.filter(
      (m) =>
        m.measure !== 'pass' &&
        (m.verdict === 'better' || m.verdict === 'worse' || (verbose && m.verdict === 'leans')),
    )
    if (!shown.length) return []
    const line = measuresLine(measures, verbose)
    const text = `${line.slice(0, 1).toUpperCase()}${line.slice(1)}.`
    return [{ depth: 2, text: several ? `${harness}: ${text}` : text, tone: 'dim' } as const]
  })
}

function compareLines(
  record: RunRecord,
  e: EvalResult,
  cells: CellResult[],
  verbose: boolean,
): DetailLine[] {
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
    lines.push(...measureLines(e, r.own, verbose))
    if (!verbose) continue
    for (const cell of r.own) {
      const stats = statsLine(cell, cells)
      const who = r.own.length > 1 ? `${harnessLabel(record, cell)}: ` : ''
      if (stats) lines.push({ depth: 2, text: `${who}${stats}`, tone: 'dim' })
    }
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

export function evalRow(
  record: RunRecord,
  e: EvalResult,
  remarks: Remark[],
  verbose = false,
): StatusRow {
  const cells = cellsOf(e)
  const decide = deciding(cells)
  const passed = decide.reduce((n, c) => n + c.passed, 0)
  const ran = decide.reduce((n, c) => n + c.passed + c.failed + c.infraError, 0)
  const compare = cells.some((c) => c.baseline)
  const counted = compare && decide.length < cells.length ? 'variant run' : 'run'
  const summary = e.todo
    ? 'todo'
    : e.notRun
      ? 'not run'
      : ran === 0
        ? e.outcome === 'canceled'
          ? 'canceled'
          : 'skipped'
        : `${passed} of ${plural(ran, counted)} passed`
  const tone = iconOf(e) === 'fail' ? 'red' : 'dim'
  const notes = ran ? [...retriedLines(decide), ...pageErrorNotes(decide)] : []
  const detail = ran
    ? [
        ...(compare
          ? compareLines(record, e, cells, verbose)
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
        ...(iconOf(e) === 'fail' ? snapshotLines(cells) : []),
        ...questionLines(e.questions ?? []),
        ...observedLines(e.observations ?? [], cells, (c) =>
          compare ? armOf(c) : harnessLabel(record, c),
        ),
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

/** Free-text answers shown per question; the rest are in the record. */
const ANSWERS_SHOWN = 3

/** Rows of `[label, text]` at `depth`, the labels padded to one column. */
const aligned = (
  depth: DetailLine['depth'],
  rows: Array<readonly [string, string]>,
): DetailLine[] => {
  const w = Math.max(0, ...rows.map(([label]) => label.length))
  return rows.map(([label, text]) => ({ depth, text: `${label.padEnd(w)}  ${text}` }))
}

/** Each question's answer: who won the pairs, the tally of choices, or the first answers. */
function questionLines(questions: Array<QuestionResult | AttemptQuestionResult>): DetailLine[] {
  return questions.flatMap((q): DetailLine[] => {
    const head = { depth: 0, text: `Question: ${clip(q.question, 100)}`, tone: 'heading' } as const
    if (q.kind === 'attempts') {
      const failed: DetailLine[] =
        q.error === null
          ? []
          : [
              {
                depth: 1,
                text: `${q.failed} of ${q.asked} not answered: ${clip(q.error, 200)}`,
                tone: 'red',
              },
            ]
      if (q.choices) {
        const tally = q.choices.map((t) => `${t.choice} ${t.n}`).join(' · ')
        return [head, { depth: 1, text: tally }, ...failed]
      }
      const shown = q.answers.slice(0, ANSWERS_SHOWN)
      const more = q.answers.length - shown.length
      return [
        head,
        ...aligned(
          1,
          shown.map((a) => [a.attempt, clip(a.text.replace(/\s+/g, ' '), 100)] as const),
        ),
        ...(more
          ? [{ depth: 1, text: `${more} more: reeval query attempt_answers`, tone: 'dim' } as const]
          : []),
        ...failed,
      ]
    }
    if (q.votes === 0 && q.error === null) {
      return [
        head,
        {
          depth: 1,
          text: 'No pairs to judge: tries that failed their checks are left out.',
          tone: 'dim',
        },
      ]
    }
    if (q.rates.length === 0 && q.error === null) {
      return [head, { depth: 1, text: `${plural(q.votes, 'vote')}, every one a tie.`, tone: 'dim' }]
    }
    const cuts = new Set(q.rates.map((r) => r.cut)).size > 1
    return [
      head,
      ...aligned(
        1,
        q.rates.map(
          (r) => [cuts ? `${r.name} (${r.cut})` : r.name, `won ${r.wins} of ${r.n}`] as const,
        ),
      ),
      ...(q.error === null
        ? []
        : [
            {
              depth: 1,
              text: `The model call failed: ${clip(q.error, 200)}`,
              tone: 'red',
            } as const,
          ]),
    ]
  })
}

/** Where a failed eval's first failed attempt's final workspace snapshot is, to open it. */
function snapshotLines(cells: CellResult[]): DetailLine[] {
  const [first, ...others] = cells.flatMap((c) => c.snapshots ?? [])
  if (!first) return []
  const more = others.length ? ` (+${others.length} more in summary.md)` : ''
  return [{ depth: 0, text: `Snapshot: ${first}${more}`, tone: 'dim' }]
}

/** What `c.observe` recorded, each name's tally on one line, or a line per cell under it. */
function observedLines(
  tallies: ObservedTally[],
  cells: CellResult[],
  label: (c: CellResult) => string,
): DetailLine[] {
  if (!tallies.length) return []
  const byKey = new Map(cells.map((c) => [c.key, c]))
  const perCell = new Set(tallies.map((t) => t.cell)).size > 1
  const width = Math.max(...tallies.map((t) => clip(t.name, 40).length))
  const lines: DetailLine[] = [{ depth: 0, text: 'Observed:', tone: 'heading' }]
  if (!perCell) {
    for (const t of tallies) {
      lines.push({ depth: 1, text: `${clip(t.name, 40).padEnd(width)}  ${observedLine(t)}` })
    }
    return lines
  }
  for (const name of new Set(tallies.map((t) => t.name))) {
    lines.push({ depth: 1, text: clip(name, 40) })
    const rows = tallies
      .filter((t) => t.name === name)
      .map((t) => {
        const cell = byKey.get(t.cell)
        return [cell ? label(cell) : t.cell, observedLine(t)] as const
      })
    const w = Math.max(...rows.map(([who]) => who.length))
    for (const [who, line] of rows) lines.push({ depth: 2, text: `${who.padEnd(w)}  ${line}` })
  }
  return lines
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
        input.verbose,
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
