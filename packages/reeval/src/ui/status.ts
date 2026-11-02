// `reeval run`'s results as a status list: one row per eval, grouped under its file, each with an
// icon, its name and `N of M runs passed`, and a detail of plain sentences from the record. The
// sentences come from fixed templates (no model), so the same run always reads the same:
//
// - Outcome, per harness (with the environment or sandbox when the eval has several):
//   one harness reads `Passed on H every time.`, `Failed on H every time.` or `Passed N of M on H.`;
//   several read `Passed on A and B every time.` when every run passed, `Failed on A and B every
//   time.` when none did, else `A passed N of M, B N of M.`
// - A compare reads a headline (`Failed on react; 2 of 3 variants helped.`, `The marked variant
//   helped.`), then one table: the control and each variant, highest pass rate first, with its
//   pass rate, effect (`, not by minLift N` when its lift missed it) and, when some measure besides
//   pass rate holds, a `vs control` column (`5× faster`; with `-v`, the leans too, each marked `(leans)`).
//   On several harnesses that comparison is a `H: …` line under the variant instead. With `-v`,
//   each cell's difference and 95% interval follows its row.
// - An eval with `cases` under `gate: { passRate }` gives each gated cell's rate over the cases:
//   `Pass rate over the cases: 67%, below passRate 0.7.` (`on <cell>` when several are gated).
// - A family whose cases didn't all pass names them: `Failed cases: green, blue.` (the first eight,
//   then `and N more`).
// - Each failed check is `✗ label  failed 2 of 4 runs`, then its first message line and
//   `file:line`, and a failed command's first stderr line; the rest of the message, the file
//   excerpt and the snapshot only in the full detail. On several harnesses it adds `, all on H` or
//   `, M of them on H`. A compare names the arms instead (`failed on react · the control
//   (expected)`), where a control that isn't gated is expected to fail.
// - Errors that aren't a check's: `✗ 2 runs hit an infrastructure error`, then the message.
// - `Worth knowing:` the eval's remarks, each its brief unless the detail is full, then each check
//   that needed its retries (`"label" passed on try 2 of 3.`) and the first capture whose page had
//   errors (`2 page errors in capture "home" → <file>`, with `(+N more captures)`); one item prints
//   on the `Worth knowing:` line itself.
//
// Only the cells that decide the outcome count: the gated ones, or every cell of a study.
import stringWidth from 'string-width'
import type { RunRecord } from '../history/types.ts'
import { clip, formatDuration, plural } from '../text.ts'
import type { ErrorKind } from '../types.ts'
import { formatUsage } from '../view/model.ts'
import { type ObservedTally, observedLine } from '../view/observations.ts'
import type { Remark, RunRemarks } from '../view/remarks.ts'
import {
  type AttemptQuestionResult,
  type CaseResult,
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

/** `failing`: still running, with a run that already failed; its outcome isn't decided yet. */
export type StatusIcon =
  | 'queued'
  | 'running'
  | 'failing'
  | 'pass'
  | 'fail'
  | 'observe'
  | 'skipped'
  | 'canceled'

/**
 * A status glyph before a detail line's text: `spin` is an attempt reeval is waiting on (the
 * interactive list animates it), `fail` a red `✗`, `miss` a dim one (a failure that doesn't fail
 * the eval, such as a compare's control), `error` a red `✗` for a timeout or infra error.
 */
export type DetailMark = 'spin' | 'pass' | 'fail' | 'miss' | 'error' | 'queued' | 'skipped'

/** A detail line: its depth under the row, and how it's painted. */
export type DetailLine = {
  depth: 0 | 1 | 2
  text: string
  tone?: 'dim' | 'red' | 'heading'
  mark?: DetailMark
  /** Dimmed after the text, past a ` · `. */
  note?: string
  /**
   * `full`: only with `-v`, or once the interactive list's open eval is opened again (file
   * excerpts, snapshot paths, a remark's whole sentence). `compact`: only without them (its short
   * form).
   */
  only?: 'compact' | 'full'
}

/** The lines a detail shows, compact or `full`. */
export const shownDetail = (lines: DetailLine[], full: boolean): DetailLine[] =>
  lines.filter((l) => !l.only || (l.only === 'full') === full)

export type StatusRow = {
  /** The eval's id, or the family's. */
  id: string
  name: string
  icon: StatusIcon
  /** `3 of 4 runs passed`, `8 of 8 variant runs passed` (a gated compare's control doesn't count), `2 of 4 runs done`, `skipped`. */
  summary: string
  detail: DetailLine[]
  /** It has remarks, under `Worth knowing:`, which a list printed once shows even on a pass. */
  remarks: number
  /** A compare, whose detail (the control and its variants) a list printed once always shows. */
  compare: boolean
  /** An eval nothing gates with answers (questions, `c.observe`), its result, which a list printed once shows. */
  answers?: boolean
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
 * A variant's comparison with the control beyond pass rate: `5× faster · judge "tidy" +0.12`, per
 * harness it ran on. Only the measures that hold; `verbose` adds the ones that only lean, each
 * `(leans)`. A judged check reads as its judge's score, not again as its pass rate.
 */
function measureSets(
  e: EvalResult,
  own: CellResult[],
  verbose: boolean,
): Array<{ harness: string; text: string }> {
  const keys = new Set(own.map((c) => c.key))
  const pooled = (e.pooled ?? []).filter((p) => keys.has(p.key))
  const sets = pooled.length
    ? pooled.map((p) => ({
        harness: own.find((c) => c.key === p.key)?.harness ?? p.key,
        measures: p.measures,
      }))
    : own.flatMap((c) => (c.measures ? [{ harness: c.harness, measures: c.measures }] : []))
  return sets.flatMap(({ harness, measures }) => {
    const shown = measures.filter(
      (m) =>
        m.measure !== 'pass' &&
        (m.verdict === 'better' || m.verdict === 'worse' || (verbose && m.verdict === 'leans')),
    )
    const judged = new Set(shown.filter((m) => m.measure === 'judge').map((m) => m.label))
    const own = shown.filter((m) => m.measure !== 'check' || !judged.has(m.label))
    if (!own.length) return []
    const text = own.map((m) => (m.verdict === 'leans' ? `${m.text} (leans)` : m.text)).join(' · ')
    return [{ harness, text }]
  })
}

const padColumns = (text: string, width: number) =>
  `${text}${' '.repeat(Math.max(0, width - stringWidth(text)))}`

/** Rows of cells padded to one column each, two spaces apart, measured in terminal columns. */
function columns(rows: string[][]): string[] {
  const widths =
    rows[0]?.map((_, i) => Math.max(...rows.map((r) => stringWidth(r[i] ?? '')))) ?? []
  return rows.map((r) =>
    r
      .map((cell, i) => padColumns(cell, widths[i] ?? 0))
      .join('  ')
      .trimEnd(),
  )
}

const upper = (text: string) => `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`

/** `Failed on react; 2 of 3 variants helped.`: what failed the compare, then what it found. */
function compareHeadline(
  failed: string[],
  rows: Array<{ v: string; effect: Effect | null }>,
): string {
  const helped = rows.filter((r) => r.effect === 'better').length
  const worse = rows.filter((r) => r.effect === 'worse').length
  const [one] = rows
  const found =
    rows.length === 1 && one
      ? one.effect === 'better' || one.effect === 'worse'
        ? `the ${one.v} variant ${EFFECT[one.effect]}`
        : one.effect === 'same'
          ? `the ${one.v} variant passed as often as the control`
          : ''
      : [
          helped ? `${helped} of ${rows.length} variants helped` : '',
          worse ? `${worse} made it worse` : '',
        ]
          .filter(Boolean)
          .join(', ') || (rows.some((r) => r.effect) ? 'no variant changed the pass rate' : '')
  const text = [failed.length ? `failed on ${failed.join(', ')}` : '', found]
    .filter(Boolean)
    .join('; ')
  return text ? `${upper(text)}.` : ''
}

/**
 * A compare as a headline, then one table: the control and each variant (highest pass rate
 * first) with its pass rate and effect, and a `vs control` column when some other measure holds.
 */
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
  const baseRow = [`${baseName} (control)`, `${of(baseTally)}${disagreement(record, base)}`]
  const variants = [...new Set(cells.filter((c) => c.variant !== null).map((c) => c.variant))]
  if (!variants.length) {
    return [
      {
        depth: 0,
        text: `Control ${baseName} passed ${of(baseTally)}${disagreement(record, base)}.`,
      },
    ]
  }
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
  const sets = rows.map((r) => measureSets(e, r.own, verbose))
  // On one harness a variant's measures are a column; on several, a line per harness under it.
  const several = new Set(cells.map((c) => c.harness)).size > 1
  const column = !several && sets.some((s) => s.length > 0)
  const table = columns([
    ['arm', 'passed', 'verdict', ...(column ? ['vs control'] : [])],
    [...baseRow, '', ...(column ? [''] : [])],
    ...rows.map((r, i) => {
      const short = minLiftShort(e, r.own)
      const word = r.effect ? `${EFFECT[r.effect]}${short}` : short.slice(2)
      return [
        r.v,
        `${of(r.t)}${disagreement(record, r.own)}`,
        word,
        ...(column ? [sets[i]?.[0]?.text ?? ''] : []),
      ]
    }),
  ])
  const failed = iconOf(e) === 'fail' ? failedArms(cells) : []
  const headline = compareHeadline(failed, rows)
  const lines: DetailLine[] = [
    ...(headline ? [{ depth: 0, text: headline } as const] : []),
    { depth: 0, text: table[0] ?? '', tone: 'dim' },
    { depth: 0, text: table[1] ?? '' },
  ]
  for (const [i, r] of rows.entries()) {
    lines.push({ depth: 0, text: table[i + 2] ?? '' })
    if (several) {
      for (const s of sets[i] ?? []) {
        lines.push({ depth: 1, text: `${s.harness}: ${s.text}`, tone: 'dim' })
      }
    }
    if (!verbose) continue
    for (const cell of r.own) {
      const stats = statsLine(cell, cells)
      const who = r.own.length > 1 ? `${harnessLabel(record, cell)}: ` : ''
      if (stats) lines.push({ depth: 1, text: `${who}${stats}`, tone: 'dim' })
    }
  }
  return lines
}

/** The arms whose gated cells failed, by name. */
function failedArms(cells: CellResult[]): string[] {
  const missed = cells.filter((c) => c.gated && c.outcome !== 'pass' && c.outcome !== 'skipped')
  return [...new Set(missed.map((c) => (c.baseline ? 'the control' : (c.variant ?? '-'))))]
}

type Tried = { failed: number; ran: number }

type FailedCheck = {
  label: string
  failed: number
  ran: number
  /** Each group's (harness, or a compare's arm) failures of it, in the cells' order. */
  byGroup: Map<string, Tried>
  /** A gated cell failed it, so it counts against the eval. */
  gated: boolean
  first: CheckResult
}

function failedChecks(cells: CellResult[], groupOf: (c: CellResult) => string): FailedCheck[] {
  const by = new Map<string, FailedCheck>()
  for (const cell of cells) {
    for (const k of cell.checks) {
      if (k.outcome.status !== 'ran' || k.outcome.failed + k.outcome.errored === 0) continue
      const n = k.outcome.failed + k.outcome.errored
      const f = by.get(k.label) ?? {
        label: k.label,
        failed: 0,
        ran: 0,
        byGroup: new Map(),
        gated: false,
        first: k,
      }
      f.failed += n
      f.gated ||= cell.gated
      const g = f.byGroup.get(groupOf(cell)) ?? { failed: 0, ran: 0 }
      g.failed += n
      f.byGroup.set(groupOf(cell), g)
      if (f.first.outcome.status === 'ran' && !f.first.outcome.assertion) f.first = k
      by.set(k.label, f)
    }
  }
  // The runs that reached each check, where it failed or not, in all and in each group it failed in.
  for (const f of by.values()) {
    f.ran = 0
    for (const c of cells) {
      const ran = c.checks.filter((k) => k.label === f.label).reduce((m, k) => m + ranOf(k), 0)
      f.ran += ran
      const g = f.byGroup.get(groupOf(c))
      if (g) g.ran += ran
    }
  }
  return [...by.values()].sort((a, b) => b.failed - a.failed || a.first.order - b.first.order)
}

/** `, all on H` or `, M of them on H`, per the rules at the top. */
function where(f: FailedCheck, harnesses: number): string {
  if (harnesses < 2) return ''
  const [top] = [...f.byGroup].sort((a, b) => b[1].failed - a[1].failed)
  if (!top) return ''
  const [h, { failed: n }] = top
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

/** The check's first failure's message: its assertion, else the judge's verdict. */
function messageOf(f: FailedCheck): string {
  const o = f.first.outcome
  const judge = f.first.judge
  return o.status === 'ran' && o.assertion
    ? o.assertion
    : judge
      ? `judge: ${judge.question} (scores ${judge.scores.join(', ')}, threshold ${judge.threshold})`
      : ''
}

const LABEL_COLUMN = 40

/**
 * `✗ label  failed 2 of 4 runs`, then the first line of its message and where it is, dimmed, and a
 * failed command's first stderr line; the message's other lines only in the full detail. A compare names the arms instead, the variants
 * first: `failed on react · the control (expected)`, where a control that isn't gated is
 * expected to fail. The `✗` is red only for a failure that counts against a failed eval.
 */
function checkLines(
  cells: CellResult[],
  groupOf: (c: CellResult) => string,
  o: { failedEval: boolean; compare: boolean; cases: boolean },
): DetailLine[] {
  const failed = failedChecks(cells, groupOf)
  if (!failed.length) return []
  const groups = new Set(cells.map(groupOf)).size
  const several = o.cases || cells.some((c) => countedOf(c) > 1)
  const baselineGated = cells.some((c) => c.baseline && c.gated)
  const width = Math.max(...failed.map((f) => clip(checkLabel(f.label), LABEL_COLUMN).length))
  const lines: DetailLine[] = []
  for (const f of failed) {
    const label = clip(checkLabel(f.label), LABEL_COLUMN).padEnd(width)
    let text: string
    let note: string | undefined
    if (o.compare) {
      const count = (t: Tried) => (several ? ` ${t.failed} of ${t.ran}` : '')
      const arms = [...f.byGroup].filter(([arm]) => arm !== 'the control')
      const base = f.byGroup.get('the control')
      const named = arms.map(([arm, t]) => `${arm}${count(t)}`).join(', ')
      const baseText = base ? `the control${count(base)}` : ''
      const expected = base && !baselineGated
      if (named) {
        text = `${label}  failed on ${named}`
        if (base) note = expected ? `${baseText} (expected)` : undefined
        if (base && !expected) text += ` · ${baseText}`
      } else {
        text = `${label}  failed on ${baseText}`
        if (expected) note = 'expected'
      }
    } else if (o.cases) {
      const shown = [...f.byGroup].slice(0, CASES_NAMED)
      const named = shown.map(([k, t]) => (t.ran > 1 ? `${k} ${t.failed} of ${t.ran}` : k))
      const more = f.byGroup.size - shown.length
      text = `${label}  failed on ${named.join(', ')}${more ? ` and ${more} more` : ''}`
    } else {
      text = `${label}  failed ${f.failed} of ${plural(f.ran, 'run')}${where(f, groups)}`
    }
    lines.push({
      depth: 0,
      mark: o.failedEval && f.gated ? 'fail' : 'miss',
      text: text.trimEnd(),
      ...(note ? { note } : {}),
    })
    const message = messageOf(f)
    const [first, ...rest] = messageLines(message, f.label)
    const at = f.first.outcome.status === 'ran' ? f.first.outcome.at : null
    const shown = [first, at].filter(Boolean).join(' · ')
    if (shown) lines.push({ depth: 1, text: shown, tone: 'dim' })
    const stderr = stderrHead(message)
    if (stderr) lines.push({ depth: 1, text: `stderr: ${clip(stderr, LINE_MAX)}`, tone: 'dim' })
    const after = stderr ? rest.filter((l) => l.trim() !== stderr) : rest
    for (const line of after) lines.push({ depth: 1, text: line, tone: 'dim', only: 'full' })
  }
  return lines
}

/** A failed command's first line on stderr, which usually says why, before what followed from it. */
function stderrHead(message: string): string | undefined {
  const section = /\n--- stderr ---\n([\s\S]*?)(?:\n--- stdout ---\n|$)/.exec(message)?.[1] ?? ''
  return section
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
}

const ranOf = (k: CheckResult) =>
  k.outcome.status === 'ran' ? k.outcome.passed + k.outcome.failed + k.outcome.errored : 0

/** Cases a sentence or a failed check names before `and N more`. */
const CASES_NAMED = 8
/** Cases the compact case table lists, the failed ones; the full detail lists every case. */
const CASES_SHOWN = 8

const ranCase = (k: CaseResult) => !k.notRun && k.outcome !== 'skipped' && k.outcome !== 'canceled'
const failedCase = (k: CaseResult) => ranCase(k) && k.outcome !== 'pass'

const namedCases = (cases: CaseResult[]) => {
  const shown = cases.slice(0, CASES_NAMED).map((k) => k.label)
  const more = cases.length - shown.length
  return `${shown.join(', ')}${more ? ` and ${more} more` : ''}`
}

/**
 * `Failed on power; 2 of 3 cases passed.`: which cases failed and how many passed, or
 * `Passed all 3 cases.`, `Ran 3 cases.` when nothing gates it.
 */
function casesHeadline(e: EvalResult, cells: CellResult[]): string {
  const cases = (e.cases ?? []).filter(ranCase)
  if (!cases.length) return 'No case finished.'
  const all = plural(cases.length, 'case')
  if (!cells.some((c) => c.gated)) return `Ran ${all}.`
  const failed = cases.filter(failedCase)
  if (!failed.length) return cases.length === 1 ? 'Passed its case.' : `Passed all ${all}.`
  const passed = `${cases.length - failed.length} of ${all} passed`
  return iconOf(e) === 'fail'
    ? `Failed on ${namedCases(failed)}; ${passed}.`
    : `${upper(passed)}; ${namedCases(failed)} failed.`
}

/** `Pass rate over the cases: 67%, below passRate 0.7.`, per cell gated on its rate. */
function rateLines(e: EvalResult): DetailLine[] {
  const rates = e.rates ?? []
  return rates.map((r): DetailLine => {
    const on = rates.length > 1 ? ` on ${r.key}` : ''
    const short = r.outcome === 'fail' ? 'below' : 'clearing'
    return {
      depth: 0,
      text: `Pass rate over the cases${on}: ${Math.round(r.rate * 100)}%, ${short} passRate ${r.passRate}.`,
      ...(r.outcome === 'fail' ? { tone: 'red' as const } : {}),
    }
  })
}

/**
 * The cases as a table: a row per case, marked with its outcome, and a column per cell (on a
 * compare, the control and then each variant) with the case's passes there. A cell where
 * `where` left the case out reads `–`. The compact detail lists every case up to `CASES_SHOWN`,
 * else only the failed ones and a count of the rest.
 */
function caseTable(
  record: RunRecord,
  e: EvalResult,
  cells: CellResult[],
  o: { compare: boolean; failedEval: boolean },
): DetailLine[] {
  const cases = e.cases ?? []
  if (!cases.length) return []
  const byKey = new Map<string, CellResult>()
  for (const c of cells) if (!byKey.has(c.key)) byKey.set(c.key, c)
  const heads = [...byKey.values()].sort(
    (a, b) => Number(b.baseline) - Number(a.baseline) || a.order - b.order,
  )
  const harnesses = new Set(heads.map((c) => c.harness)).size > 1
  const own = labeler(record, heads)
  const label = o.compare
    ? (c: CellResult) =>
        [
          c.baseline ? `${c.environment} (control)` : (c.variant ?? c.environment),
          harnesses ? harnessLabel(record, c) : '',
        ]
          .filter(Boolean)
          .join(' · ')
    : own
  const marked = cells.some((c) => c.gated)
  const table = columns([
    ['case', ...heads.map(label)],
    ...cases.map((k) => [
      k.label,
      ...heads.map((h) => {
        const cell = k.cells.find((c) => c.key === h.key)
        return cell && countedOf(cell) > 0 ? `${cell.passed} of ${countedOf(cell)}` : '–'
      }),
    ]),
  ])
  const compact = cases.length <= CASES_SHOWN ? cases : cases.filter(failedCase).slice(0, CASES_SHOWN)
  const shown = new Set(compact)
  const lines: DetailLine[] = [
    {
      depth: 0,
      text: `${marked ? '  ' : ''}${table[0] ?? ''}`,
      tone: 'dim',
      ...(compact.length ? {} : { only: 'full' as const }),
    },
  ]
  for (const [i, k] of cases.entries()) {
    const mark: DetailMark = !ranCase(k)
      ? 'skipped'
      : k.outcome === 'pass'
        ? 'pass'
        : o.failedEval
          ? 'fail'
          : 'miss'
    lines.push({
      depth: 0,
      text: table[i + 1] ?? '',
      ...(marked ? { mark } : {}),
      ...(shown.has(k) ? {} : { only: 'full' as const }),
    })
  }
  const hidden = cases.filter((k) => !shown.has(k))
  if (hidden.length) {
    const word = hidden.length === 1 ? 'case' : 'cases'
    const passed = hidden.every((k) => k.outcome === 'pass') ? ' passed' : ''
    const count = compact.length ? `+${hidden.length} more ${word}` : `${hidden.length} ${word}`
    lines.push({ depth: 0, text: `${count}${passed} (-v)`, tone: 'dim', only: 'compact' })
  }
  return lines
}

/**
 * Errors no failed check explains: timeouts, infrastructure errors, throws. Never clipped: their
 * remedy is often last. A throw fails its attempt as a failed check does, so it reads as one; the
 * rest are errors, red on a failed eval.
 */
function errorLines(cells: CellResult[], failedEval: boolean): DetailLine[] {
  const by = new Map<string, { kind: ErrorKind | 'turn'; message: string; n: number }>()
  for (const c of cells) {
    for (const err of c.errors) {
      const key = `${err.kind}\n${err.message}`
      const e = by.get(key) ?? { kind: err.kind, message: err.message, n: 0 }
      e.n += err.attempts
      by.set(key, e)
    }
  }
  return [...by.values()].flatMap((e) => {
    const fail = e.kind === 'assertion'
    const mark = e.kind === 'aborted' ? 'skipped' : !failedEval ? 'miss' : fail ? 'fail' : 'error'
    const tone = fail || !failedEval ? 'dim' : 'red'
    return [
      { depth: 0, mark, text: `${plural(e.n, 'run')} ${ERROR_VERB[e.kind]}` } as const,
      ...messageLines(e.message, '', Number.POSITIVE_INFINITY).map(
        (text) => ({ depth: 1, text, tone }) as const,
      ),
    ]
  })
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

/**
 * `Worth knowing:` on the line itself when there's one remark or note, else as a heading over
 * them. A remark with a short form (`brief`) gives it, and its whole sentence in the full detail.
 */
function remarkLines(remarks: Remark[], notes: string[]): DetailLine[] {
  const items = [
    ...remarks.map((r) => {
      const full = r.fix.edit
        ? `${r.text} Fix at ${location(r.fix.at)}: ${r.fix.edit}.`
        : `${r.text} At ${location(r.fix.at)}.`
      return { full, compact: r.brief ?? full }
    }),
    ...notes.map((text) => ({ full: text, compact: text })),
  ]
  if (!items.length) return []
  const one = items.length === 1
  const lines: DetailLine[] = one ? [] : [{ depth: 0, text: 'Worth knowing:', tone: 'heading' }]
  const depth = one ? 0 : 1
  const lead = one ? 'Worth knowing: ' : ''
  for (const { full, compact } of items) {
    if (compact === full) lines.push({ depth, text: `${lead}${full}` })
    else {
      lines.push({ depth, text: `${lead}${compact}`, only: 'compact' })
      lines.push({ depth, text: `${lead}${full}`, only: 'full' })
    }
  }
  return lines
}

/** A compare's failures are told apart by arm: `the control`, or the variant's name. */
const armOf = (c: CellResult) => (c.baseline ? 'the control' : (c.variant ?? c.environment))

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
  const cases = e.cases ?? []
  const failedEval = iconOf(e) === 'fail'
  const notes = ran ? [...retriedLines(decide), ...pageErrorNotes(decide)] : []
  const caseOf = new Map(cases.flatMap((k) => k.cells.map((c) => [c, k.label] as const)))
  const answers = [
    ...questionLines(e.questions ?? []),
    ...observedLines(e.observations ?? [], cells, (c) =>
      compare ? armOf(c) : harnessLabel(record, c),
    ),
  ]
  const detail = ran
    ? [
        ...(compare
          ? compareLines(record, e, cells, verbose)
          : [
              {
                depth: 0,
                text: cases.length
                  ? casesHeadline(e, decide)
                  : outcomeSentence(tallyBy(decide, labeler(record, decide))),
              } as const,
            ]),
        ...rateLines(e),
        ...caseTable(record, e, compare ? cells : decide, { compare, failedEval }),
        ...(compare
          ? checkLines(cells, armOf, { failedEval, compare, cases: false })
          : cases.length
            ? checkLines(decide, (c) => caseOf.get(c) ?? c.key, {
                failedEval,
                compare,
                cases: true,
              })
            : checkLines(decide, (c) => harnessLabel(record, c), {
                failedEval,
                compare,
                cases: false,
              })),
        ...errorLines(compare ? cells : decide, failedEval),
        ...(failedEval ? snapshotLines(cells) : []),
        ...answers,
        ...remarkLines(remarks, notes),
      ]
    : remarkLines(remarks, [])
  return {
    id: e.id,
    name: nameOf(e),
    icon: iconOf(e),
    summary: ran && cases.length ? `${summary} · ${plural(cases.length, 'case')}` : summary,
    detail,
    remarks: remarks.length + notes.length,
    compare,
    ...(ran && answers.length && iconOf(e) === 'observe' ? { answers: true } : {}),
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
  return [{ depth: 0, text: `Snapshot: ${first}${more}`, tone: 'dim', only: 'full' }]
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

/** `3 passed · 1 failed · 1 ran`, from the suite's tally. */
export function tallyText(suite: SuiteResult): string {
  const t = suite.tally
  return [
    t.errors ? plural(t.errors, 'run error') : '',
    t.fail ? `${t.fail} failed` : '',
    t.infraError ? plural(t.infraError, 'infra error') : '',
    t.canceled ? `${t.canceled} canceled` : '',
    t.pass ? `${t.pass} passed` : '',
    t.notGated ? `${t.notGated} ran` : '',
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
