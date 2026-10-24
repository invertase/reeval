// The result blocks every surface prints (the terminal, summary.md, `reeval show`): one block per
// eval, a pooled family being one, laid out by what the eval's cells compare, then the tally.
// Pure and deterministic: the same SuiteResult and insights always print the same lines. Counts
// read `N of M` and effects are words; statistics print only with `verbose`. Insights fill the
// slots a layout opens (an answer, a sentence on a row, findings, the headline) and never add or
// remove a fact row; written for other facts, they're left out with a note.
import { factsHash } from '../insights/hash.ts'
import type { InsightSlots } from '../insights/input.ts'
import { clip, oneLine } from '../text.ts'
import { formatTokens } from '../usage.ts'
import { formatCount, formatSeconds } from '../view/effort.ts'
import { type EvalInsight, fromModel, type Job, type RunInsights } from '../view/insights.ts'
import type {
  Across,
  AttemptQuestionResult,
  CaseResult,
  CellError,
  CellResult,
  CheckResult,
  Effect,
  EvalResult,
  Interval,
  PooledArm,
  QuestionResult,
  ResultOutcome,
  SuiteResult,
} from '../view/suite.ts'
import { cancelledOf, countedOf, isNotGatedResult, isStudy } from '../view/suite.ts'
import { type Colors, colors, type Paint } from './colors.ts'
import { remarkLines } from './remarks.ts'

export type { Job }

export type Layout = {
  kind: 'results' | 'choose' | 'measure' | 'harnesses' | 'both' | 'regressions'
  /** A pooled `evaluate.each`: the kind's rows, one per case, inside one block. */
  family: boolean
}

/** The block for an eval: a pure function of its job and its shape. */
export function layout(job: Job, across: Across, isFamily: boolean, isCompare: boolean): Layout {
  if (isCompare) return { kind: 'regressions', family: false }
  const kind =
    job === 'choose' && across === 'none'
      ? 'choose'
      : across === 'change'
        ? 'measure'
        : across === 'harness'
          ? 'harnesses'
          : across === 'both'
            ? 'both'
            : 'results'
  return { kind, family: isFamily }
}

const moved = (c: CellResult) => c.effect === 'better' || c.effect === 'worse'
/** A cell the agent failed, or that errored; not one whose only fails the interrupt cancelled. */
const failedCell = (c: CellResult) =>
  (c.outcome === 'fail' && c.failed > cancelledOf(c)) || c.outcome === 'infra_error'

/**
 * The insight slots an eval's layout opens: which rows take a sentence (a failing case; an arm
 * that failed or moved; a failing harness), whether it has findings (a choose or finish eval that
 * measures a change), and whether it has named tools (a choose eval). An `other` eval takes only
 * its answer, unless it compares harnesses, which takes a sentence on any job. What the run's
 * interrupt cancelled opens nothing: the agent didn't fail it, and its effects aren't measured.
 */
export function slotsOf(job: Job, e: EvalResult): InsightSlots {
  const known = job !== 'other'
  const measured = e.outcome !== 'cancelled'
  const harnesses = e.across === 'harness' || e.across === 'both'
  const rows: string[] = []
  if (known || harnesses) {
    if (e.cases) {
      for (const k of e.cases)
        if (k.outcome !== 'pass' && k.outcome !== 'cancelled') rows.push(k.path)
      for (const p of e.pooled ?? []) {
        const pooledMoved = measured && (p.effect === 'better' || p.effect === 'worse')
        if (p.outcome === 'fail' || pooledMoved) rows.push(p.path)
      }
    } else if (e.across === 'harness') {
      for (const c of e.cells ?? []) if (failedCell(c)) rows.push(c.path)
    } else if (e.across === 'change' || e.across === 'both') {
      for (const c of e.cells ?? []) if (failedCell(c) || (measured && moved(c))) rows.push(c.path)
    }
  }
  const findings = known && e.across === 'change' && measured
  return { rows, findings, namedTools: job === 'choose' }
}

export type RenderOptions = {
  color: boolean
  /** `-v`: each variant's difference and interval under its effect word. */
  verbose: boolean
  /** Lines between the blocks and the tally, as they are: the run's time and where its results are. */
  notes?: string[]
  /** Ends with `NO_MODEL_HINT`: `analysis.model` is unset (see `hasAnalysisModel`). */
  hint: boolean
}

/** The last line of a run's output while no analysis model writes its answers. */
export const NO_MODEL_HINT =
  'Set analysis.model in reeval.config.ts for answers to what each eval asks.'

/** Where a block's name starts, after its verdict word. */
export const HEAD = 17
/** The narrowest a row's label column is, so short labels line up under the name. */
const LABEL = 17
const ASSERTION_MAX = 160
const CHECK_LABEL_MAX = 48

/** A check's label on one line: an expected value can carry line breaks. */
export const checkLabel = (label: string) => clip(label.replace(/\s*\n\s*/g, ' '), CHECK_LABEL_MAX)

const VERDICT: Record<ResultOutcome, string> = {
  pass: 'pass',
  fail: 'fail',
  infra_error: 'infra error',
  cancelled: 'cancelled',
  skipped: 'skipped',
}

const EFFECT: Record<Effect, string> = {
  better: 'helped',
  worse: 'made it worse',
  unclear: "can't tell yet",
  same: '',
}

export type Text = { text: string; paint?: Paint }
/** One row: its cells line up with the other rows of its table. */
type Row = { indent: number; cells: Array<string | Text> }
/** A line printed as it is, under a row. */
type Free = { indent: number; free: string | Text }
export type Item = Row | Free

export const t = (text: string, paint?: Paint): Text => ({ text, paint })
const textOf = (cell: string | Text) => (typeof cell === 'string' ? cell : cell.text)
export const show = (cell: string | Text) =>
  typeof cell === 'string' ? cell : cell.paint ? cell.paint(cell.text) : cell.text

/**
 * Aligned rows: the first column is as wide as the widest label with its indent (at least
 * `LABEL`), the others as their widest cell, two spaces apart. Free lines print as they are.
 */
export function table(items: Item[], width = LABEL): string[] {
  const rows = items.filter((i): i is Row => 'cells' in i)
  const first = Math.max(
    width,
    ...rows
      .filter((r) => r.cells.length > 1)
      .map((r) => r.indent + textOf(r.cells[0] ?? '').length),
  )
  const widths: number[] = []
  for (const r of rows) {
    r.cells.forEach((cell, i) => {
      if (i > 0) widths[i] = Math.max(widths[i] ?? 0, textOf(cell).length)
    })
  }
  return items.map((item) => {
    const pad = ' '.repeat(item.indent)
    if ('free' in item) return `${pad}${show(item.free)}`
    const out = item.cells.map((cell, i) => {
      const width = i === 0 ? first - item.indent : (widths[i] ?? 0)
      const fill = ' '.repeat(Math.max(0, width - textOf(cell).length))
      return i === item.cells.length - 1 ? show(cell) : `${show(cell)}${fill}`
    })
    return `${pad}${out.join('  ')}`.trimEnd()
  })
}

const paintOutcome = (c: Colors, o: ResultOutcome): Paint =>
  o === 'pass'
    ? c.green
    : o === 'fail'
      ? c.red
      : o === 'infra_error' || o === 'cancelled'
        ? c.yellow
        : c.dim

function verdict(c: Colors, e: Pick<EvalResult, 'outcome' | 'todo' | 'cells'>): Text {
  if (e.todo) return t('todo', c.dim)
  if (e.outcome === 'pass' && isStudy(e.cells ?? [])) return t('not gated', c.dim)
  return t(VERDICT[e.outcome], paintOutcome(c, e.outcome))
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * `3 of 4`, with the attempts that didn't count named: `2 of 3 · 1 infra error · 1 skipped`. A
 * cancelled attempt is recorded as a fail, but the agent didn't fail it, so it's named apart.
 */
function cellCount(cell: CellResult): string {
  const cancelled = cancelledOf(cell)
  const counted = countedOf(cell)
  const parts = [
    counted > 0 ? `${cell.passed} of ${counted}` : '',
    cell.infraError ? plural(cell.infraError, 'infra error') : '',
    cancelled ? `${cancelled} cancelled` : '',
    cell.skipped ? `${cell.skipped} skipped` : '',
  ].filter(Boolean)
  if (!parts.length) return 'not run'
  return parts.join(' · ')
}

const failing = (k: CheckResult) =>
  k.outcome.status === 'not run' || k.outcome.failed + k.outcome.errored > 0

/** A check's result in a cell: `not run`, `failed` for one try, else `1 of 4 · 2 not run`. */
export function checkCount(k: CheckResult, single: boolean): string {
  const o = k.outcome
  if (o.status === 'not run') return 'not run'
  const answered = o.passed + o.failed + o.errored
  const head =
    single && answered === 1
      ? o.failed
        ? 'failed'
        : o.errored
          ? "couldn't check"
          : 'passed'
      : `${o.passed} of ${answered}`
  const notes = [
    !single && o.errored ? `${o.errored} couldn't check` : '',
    o.notRun ? `${o.notRun} not run` : '',
  ].filter(Boolean)
  return [head, ...notes].join(' · ')
}

/** The check's first failure, less the `label: ` its row already shows. */
export function assertionOf(k: CheckResult): string {
  if (k.outcome.status !== 'ran' || !k.outcome.assertion) return ''
  const line = k.outcome.assertion.trim().split('\n')[0]?.trim() ?? ''
  return clip(
    line.startsWith(`${k.label}: `) ? line.slice(k.label.length + 2) : line,
    ASSERTION_MAX,
  )
}

/** A cell passed outright: every counted attempt, every check, nothing errored. */
const clean = (cell: CellResult) =>
  cell.outcome === 'pass' &&
  cell.failed === 0 &&
  cell.infraError === 0 &&
  cell.errors.length === 0 &&
  !cell.checks.some(failing)

/** An error no check explains, by kind: a throw in the eval's body reads `error`. */
const ERROR_KIND: Record<CellError['kind'], string> = {
  assertion: 'error',
  judge: 'judge',
  timeout: 'timeout',
  aborted: 'cancelled',
  infra: 'infra error',
  turn: 'turn error',
}

export const errorKind = (err: CellError) => ERROR_KIND[err.kind]

export const errorText = (err: CellError) =>
  `${clip(err.message, ASSERTION_MAX)}${err.attempts > 1 ? ` (${plural(err.attempts, 'try', 'tries')})` : ''}`

/** The evidence under a failing cell: its failed and not-run checks, its errors, `+N more passed`. */
function evidence(c: Colors, cell: CellResult, indent: number, more = true): Item[] {
  const single = cell.passed + cell.failed + cell.infraError <= 1
  const items: Item[] = []
  for (const k of cell.checks.filter(failing)) {
    const count = checkCount(k, single)
    items.push({
      indent,
      cells: [checkLabel(k.label), count === 'not run' ? t(count, c.dim) : t(count, c.red)],
    })
    const assertion = assertionOf(k)
    if (assertion) items.push({ indent: indent + 2, free: t(assertion, c.dim) })
    if (k.retried) items.push({ indent: indent + 2, free: t(k.retried, c.dim) })
  }
  for (const err of cell.errors) {
    items.push({ indent, cells: [errorKind(err), t(errorText(err), c.dim)] })
  }
  items.push(...retriedItems(c, cell, indent))
  const passed = cell.checks.filter((k) => !failing(k) && !k.retried).length
  if (more && passed && items.length) {
    items.push({ indent, free: t(`+${passed} more passed`, c.dim) })
  }
  return items
}

/** Passing checks that needed their `c.exec` retries: `npm test  passed on try 2 of 3`. */
const retriedItems = (c: Colors, cell: CellResult, indent: number): Item[] =>
  cell.checks
    .filter((k) => !failing(k) && k.retried)
    .map((k) => ({ indent, cells: [checkLabel(k.label), t(k.retried ?? '', c.dim)] }))

/** A control with no environment of its own is the baseline the variants change. */
const armOf = (cell: CellResult) =>
  cell.variant ?? (cell.environment === '-' ? 'baseline' : cell.environment)

/** Each cell's label: the parts that vary between them (harness, arm, sandbox). */
export function labeller(cells: CellResult[], parts: Array<'harness' | 'arm' | 'sandbox'>) {
  const vary = parts.filter((p) => {
    const of = (cell: CellResult) =>
      p === 'harness' ? cell.harness : p === 'arm' ? armOf(cell) : cell.sandbox
    return new Set(cells.map(of)).size > 1
  })
  const used = vary.length ? vary : parts.slice(0, 1)
  return (cell: CellResult) =>
    used
      .map((p) => (p === 'harness' ? cell.harness : p === 'arm' ? armOf(cell) : cell.sandbox))
      .join(' · ')
}

const effectText = (c: Colors, effect: Effect | null): Text => {
  if (!effect) return t('')
  const paint = effect === 'better' ? c.green : effect === 'worse' ? c.red : c.yellow
  return t(EFFECT[effect], paint)
}

const signedPoints = (x: number) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}`

/** `-v`: a variant's difference from its baseline and the interval its effect comes from. */
function statsLine(cell: CellResult, cells: CellResult[]): string | null {
  const base = cells.find((x) => x.key === cell.vs)
  if (!base || !cell.interval) return null
  const rate = (x: CellResult) => (x.passed + x.failed ? x.passed / (x.passed + x.failed) : 0)
  return `difference ${signedPoints(rate(cell) - rate(base))} points, 95% interval ${signedPoints(cell.interval.low)}…${signedPoints(cell.interval.high)}`
}

/** The checks that failed or didn't run in some cell, a column per cell; the rest pass everywhere. */
function checkMatrix(
  c: Colors,
  cells: CellResult[],
  label: (cell: CellResult) => string,
  indent: number,
  width: number,
): string[] {
  const labels = [...new Set(cells.flatMap((x) => x.checks.map((k) => k.label)))]
  const shown = labels.filter((l) =>
    cells.some((x) => x.checks.some((k) => k.label === l && failing(k))),
  )
  if (!shown.length) return []
  const items: Item[] = [{ indent, cells: ['check', ...cells.map((x) => t(label(x), c.dim))] }]
  for (const l of shown) {
    const row = cells.map((x) => {
      const k = x.checks.find((y) => y.label === l)
      if (!k) return t('–', c.dim)
      const count = checkCount(k, false)
      if (!failing(k)) return t(count)
      return t(count, k.outcome.status === 'not run' || !x.gated ? c.dim : c.red)
    })
    items.push({ indent, cells: [checkLabel(l), ...row] })
    const assertion = cells
      .map((x) => x.checks.find((y) => y.label === l))
      .map((k) => (k ? assertionOf(k) : ''))
      .find(Boolean)
    if (assertion) items.push({ indent: indent + 2, free: t(assertion, c.dim) })
  }
  const passed = labels.length - shown.length
  if (passed) items.push({ indent, free: t(`+${passed} more passed`, c.dim) })
  return table(items, width)
}

/** Tools, agent time and tokens per cell, when each has enough tries and it matters. */
function effortTable(
  c: Colors,
  cells: CellResult[],
  label: (cell: CellResult) => string,
  indent: number,
  failed: boolean,
  width: number,
): string[] {
  if (cells.length < 2 || cells.some((x) => !x.effort)) return []
  if (!failed && !cells.some((x) => x.effortDiffers)) return []
  const tokens = cells.some((x) => x.effort?.tokens !== null)
  const n = (v: number | null | undefined, f: (v: number) => string) => (v == null ? '–' : f(v))
  const items: Item[] = [
    {
      indent,
      cells: [
        'effort',
        t('tools', c.dim),
        t('time', c.dim),
        ...(tokens ? [t('tokens', c.dim)] : []),
      ],
    },
    ...cells.map((x) => ({
      indent,
      cells: [
        label(x),
        n(x.effort?.tools, formatCount),
        n(x.effort?.agentMs, formatSeconds),
        ...(tokens ? [n(x.effort?.tokens, formatTokens)] : []),
      ],
    })),
  ]
  return table(items, width)
}

/**
 * `failed`: the eval or case didn't pass, so its effort prints, and a family case's check matrix.
 * `effects`: the arms carry effect words and the check matrix, which a family's cases leave to
 * its pooled row unless they failed.
 */
type BodyOptions = { failed: boolean; verbose: boolean; effects: boolean; slots: Slots }

/** What an eval's insight puts under its rows: a row's sentence, and a choose eval's named tools. */
type Slots = {
  row: (path: string) => string | null
  /** The tools named over the cells' tries, most first; empty unless the eval is choose. */
  named: (cells: CellResult[]) => Array<{ tool: string; tries: number }>
  /** The tool a choose eval asks about. */
  subject: string | null
}

const NO_SLOTS: Slots = { row: () => null, named: () => [], subject: null }

const triesOf = (cells: CellResult[]) => cells.reduce((n, x) => n + countedOf(x), 0)

/** `named`, then a row per tool with the tries that named it. */
function namedItems(c: Colors, slots: Slots, cells: CellResult[], indent: number): Item[] {
  const named = slots.named(cells)
  if (!named.length) return []
  const of = triesOf(cells)
  return [
    { indent, free: t('named', c.dim) },
    ...named.map((n) => ({ indent: indent + 2, cells: [n.tool, `${n.tries} of ${of}`] })),
  ]
}

/** The tries that named the subject, over the cells' tries: `0 of 4`; empty with no subject. */
function subjectTries(slots: Slots, cells: CellResult[]): string {
  if (!slots.subject) return ''
  const subject = slots.subject.toLowerCase()
  const n = slots.named(cells).find((x) => x.tool.toLowerCase() === subject)?.tries ?? 0
  return `${n} of ${triesOf(cells)}`
}

/** Web searches or fetches over the tries, when every try reported a number. */
function webItems(cells: CellResult[], indent: number): Item[] {
  const row = (name: string, counts: Array<number | null>): Item[] =>
    counts.length && counts.every((x) => x !== null)
      ? [{ indent, cells: [name, String(counts.reduce((a, b) => (a ?? 0) + (b ?? 0), 0))] }]
      : []
  return [
    ...row(
      'searches',
      cells.flatMap((x) => x.searches),
    ),
    ...row(
      'fetches',
      cells.flatMap((x) => x.fetches),
    ),
  ]
}

/** A choose case that missed: its failed checks, the tools named, its searches, then `+N more passed`. */
function chooseDetail(c: Colors, cells: CellResult[], indent: number, slots: Slots): Item[] {
  const checks = cells.flatMap((cell) => evidence(c, cell, indent, false))
  const passed = cells.flatMap((x) => x.checks.filter((k) => !failing(k))).length
  return [
    ...checks,
    ...namedItems(c, slots, cells, indent),
    ...webItems(cells, indent),
    ...(passed ? [{ indent, free: t(`+${passed} more passed`, c.dim) }] : []),
  ]
}

/** Choose a tool, on a single eval: the subject's count, and on a miss the detail. */
function chooseBody(c: Colors, cells: CellResult[], indent: number, slots: Slots): string[] {
  const items: Item[] = slots.subject
    ? [{ indent, cells: [slots.subject, subjectTries(slots, cells)] }]
    : []
  if (!cells.every(clean)) items.push(...chooseDetail(c, cells, indent, slots))
  return table(items)
}

/** A row's sentence, as a line under it. */
const rowLine = (slots: Slots, path: string, indent: number): Item[] => {
  const text = slots.row(path)
  return text ? [{ indent, free: text }] : []
}

/** Measure a change: a row per arm with its effect, the check matrix and the effort table. */
function measureBody(c: Colors, cells: CellResult[], indent: number, o: BodyOptions): string[] {
  const label = labeller(cells, ['arm', 'sandbox'])
  const arms: Item[] = [{ indent, cells: ['arm', t('pass', c.dim)] }]
  for (const cell of cells) {
    const effect = o.effects ? gatedEffect(c, cell) : t('')
    arms.push({ indent, cells: [label(cell), cellCount(cell), ...(effect.text ? [effect] : [])] })
    arms.push(
      ...rowLine(o.slots, cell.path, indent + 2),
      ...namedItems(c, o.slots, [cell], indent + 2),
    )
    const stats = o.verbose && o.effects ? statsLine(cell, cells) : null
    if (stats) arms.push({ indent: indent + 2, free: t(stats, c.dim) })
    for (const err of cell.errors) {
      arms.push({ indent: indent + 2, free: t(`${errorKind(err)}  ${errorText(err)}`, c.dim) })
    }
  }
  const matrix = o.failed || o.effects
  const labels = [
    ...cells.map(label),
    ...(matrix
      ? cells.flatMap((x) => x.checks.filter(failing).map((k) => checkLabel(k.label)))
      : []),
  ]
  const width = Math.max(LABEL, ...labels.map((l) => indent + l.length))
  return [
    ...table(arms, width),
    ...(matrix ? checkMatrix(c, cells, label, indent, width) : []),
    ...effortTable(c, cells, label, indent, o.failed, width),
  ]
}

/** A row per cell (harness, or sandbox), the ones that didn't pass outright with their evidence. */
function cellRows(
  c: Colors,
  cells: CellResult[],
  heading: string,
  indent: number,
  slots: Slots,
): string[] {
  const label = labeller(cells, heading === 'harness' ? ['harness', 'sandbox'] : ['sandbox'])
  const items: Item[] = [{ indent, cells: [heading, t('pass', c.dim)] }]
  for (const cell of cells) {
    items.push({ indent, cells: [label(cell), cellCount(cell)] })
    items.push(...rowLine(slots, cell.path, indent + 2))
    if (!clean(cell)) {
      items.push(...namedItems(c, slots, [cell], indent + 2), ...evidence(c, cell, indent + 2))
    }
  }
  return table(items)
}

/** Compare harnesses with arms: a heading per harness, its arms as Measure a change under it. */
function bothBody(c: Colors, cells: CellResult[], indent: number, o: BodyOptions): string[] {
  const harnessOf = labeller(cells, ['harness', 'sandbox'])
  const groups = new Map<string, CellResult[]>()
  for (const cell of cells)
    groups.set(harnessOf(cell), [...(groups.get(harnessOf(cell)) ?? []), cell])
  return [...groups].flatMap(([harness, group]) => [
    `${' '.repeat(indent)}${harness}`,
    ...measureBody(c, group, indent + 2, o),
  ])
}

/** The rows under an eval's head (or a family case's), by what its cells compare. */
function cellsBody(
  c: Colors,
  kind: Layout['kind'],
  cells: CellResult[],
  indent: number,
  o: BodyOptions,
): string[] {
  if (kind === 'measure') return measureBody(c, cells, indent, o)
  if (kind === 'harnesses') return cellRows(c, cells, 'harness', indent, o.slots)
  if (kind === 'both') return bothBody(c, cells, indent, o)
  if (kind === 'choose') return chooseBody(c, cells, indent, o.slots)
  if (cells.length > 1) return cellRows(c, cells, 'sandbox', indent, o.slots)
  return resultsBody(c, cells[0] as CellResult, indent)
}

/** A single eval with one cell: its tries, and on anything but a clean pass, the evidence. */
function resultsBody(c: Colors, cell: CellResult, indent: number): string[] {
  if (clean(cell)) return table(retriedItems(c, cell, indent))
  const items: Item[] = []
  if (cell.attempts > 1) {
    items.push({ indent, cells: [plural(cell.attempts, 'try', 'tries'), cellCount(cell)] })
  }
  return table([...items, ...evidence(c, cell, indent)])
}

/** Free-text answers shown per question; the rest are in the record. */
const ANSWERS_SHOWN = 3

function attemptQuestionLines(c: Colors, q: AttemptQuestionResult, indent: number): string[] {
  const pad = ' '.repeat(indent)
  const head = `${pad}${c.dim('question')}  ${clip(q.question, 100)}`
  const failed =
    q.error === null
      ? []
      : [
          `${pad}  ${c.yellow(`the model call failed on ${q.failed} of ${q.asked}: ${clip(q.error, 200)}`)}`,
        ]
  if (q.choices) {
    const tally = q.choices.map((t) => `${t.choice} ${t.n}`).join(' · ')
    return [head, `${pad}  ${tally}`, ...failed]
  }
  const shown = q.answers.slice(0, ANSWERS_SHOWN)
  const rows = table(
    shown.map((a) => ({
      indent: indent + 2,
      cells: [a.attempt, clip(a.text.replace(/\s+/g, ' '), 100)],
    })),
  )
  const more = q.answers.length - shown.length
  const rest = more ? [`${pad}  ${c.dim(`${more} more: reeval query attempt_answers`)}`] : []
  return [head, ...rows, ...rest, ...failed]
}

function questionLines(
  c: Colors,
  questions: Array<QuestionResult | AttemptQuestionResult>,
  indent: number,
): string[] {
  return questions.flatMap((q) => {
    if (q.kind === 'attempts') return attemptQuestionLines(c, q, indent)
    const pad = ' '.repeat(indent)
    const head = `${pad}${c.dim('question')}  ${clip(q.question, 100)}`
    if (q.votes === 0 && q.error === null) {
      return [
        head,
        `${pad}  ${c.dim('no pairs to judge: tries that failed their checks are left out')}`,
      ]
    }
    if (q.rates.length === 0 && q.error === null) {
      return [
        head,
        `${pad}  ${c.dim(`${q.votes} ${q.votes === 1 ? 'vote' : 'votes'}, every one a tie`)}`,
      ]
    }
    const cuts = new Set(q.rates.map((r) => r.cut)).size > 1
    const rows = table(
      q.rates.map((r) => ({
        indent: indent + 2,
        cells: [cuts ? `${r.name} (${r.cut})` : r.name, `won ${r.wins} of ${r.n}`],
      })),
    )
    const failed =
      q.error === null
        ? []
        : [`${pad}  ${c.yellow(`the model call failed: ${clip(q.error, 200)}`)}`]
    return [head, ...rows, ...failed]
  })
}

/** A cell's counts summed over a family's cases. */
function pooledCount(cases: CaseResult[], key: string): string {
  let passed = 0
  let counted = 0
  for (const k of cases) {
    const cell = k.cells.find((x) => x.key === key)
    if (!cell) continue
    passed += cell.passed
    counted += cell.passed + cell.failed
  }
  return counted ? `${passed} of ${counted}` : 'not run'
}

/** A variant's effect, with the `minLift` its interval's low end fell short of, which fails it. */
function gatedEffect(
  c: Colors,
  arm: { effect: Effect | null; minLift: number | null; interval: Interval | null },
): Text {
  const effect = effectText(c, arm.effect)
  if (arm.minLift === null || !arm.interval || arm.interval.low >= arm.minLift) return effect
  const short = `not by minLift ${Math.round(arm.minLift * 100)}`
  return t(effect.text ? `${effect.text}, ${short}` : short, c.red)
}

function pooledStats(p: PooledArm, label: string) {
  return `${label}: ${p.pairs} paired cases, 95% interval ${signedPoints(p.interval.low)}…${signedPoints(p.interval.high)}`
}

/**
 * A family: its template, then a row per case. With one cell a case is a row with its count;
 * with more, the case is outer and its cells inner, laid out as a single eval's are, and a
 * pooled `all cases` row sums each cell's counts with its variant's pooled effect. A choose
 * family's case row carries the subject's count instead, and a missed case the tools named.
 */
function familyBlock(
  c: Colors,
  e: EvalResult,
  kind: Layout['kind'],
  verbose: boolean,
  slots: Slots,
): string[] {
  const cases = e.cases ?? []
  const columns = [
    ...new Map(cases.flatMap((k) => k.cells).map((cell) => [cell.key, cell])).values(),
  ]
  const pooled = e.pooled ?? []
  const pooledOutcome: ResultOutcome = pooled.some((p) => p.outcome === 'fail') ? 'fail' : 'pass'
  const caseWord = (k: CaseResult) =>
    verdict(c, { outcome: k.outcome, todo: false, cells: k.cells })
  const pooledWord = isNotGatedResult(e)
    ? t('not gated', c.dim)
    : t(VERDICT[pooledOutcome], paintOutcome(c, pooledOutcome))
  const words = [...cases.map(caseWord), ...(pooled.length ? [pooledWord] : [])]
  const wordWidth = Math.max(...words.map((w) => w.text.length))
  const lead = (word: Text, name: string): Text => ({
    text: `${word.text.padEnd(wordWidth)}  ${name}`,
    paint: (s) => `${show(word)}${s.slice(word.text.length)}`,
  })
  const head = `${' '.repeat(HEAD)}${e.template ?? e.name}`
  const questions = questionLines(c, e.questions, 2)
  if (kind === 'choose') {
    const subject = slots.subject ? [t(slots.subject, c.dim)] : []
    const items: Item[] = [{ indent: 2, cells: ['case', t('pass', c.dim), ...subject] }]
    for (const k of cases) {
      const passed = k.cells.reduce((n, x) => n + x.passed, 0)
      const tries = triesOf(k.cells)
      const count =
        k.cells.length === 1 && k.cells[0]
          ? cellCount(k.cells[0])
          : tries
            ? `${passed} of ${tries}`
            : 'not run'
      const named = slots.subject && tries ? [subjectTries(slots, k.cells)] : []
      items.push({ indent: 2, cells: [lead(caseWord(k), k.label), count, ...named] })
      items.push(...rowLine(slots, k.path, 4))
      if (!k.cells.every(clean)) items.push(...chooseDetail(c, k.cells, 4, slots))
    }
    return [head, ...table(items), ...questions]
  }
  if (columns.length <= 1) {
    const items: Item[] = []
    for (const k of cases) {
      const cell = k.cells[0]
      items.push({ indent: 2, cells: [lead(caseWord(k), k.label), cell ? cellCount(cell) : ''] })
      items.push(...rowLine(slots, k.path, 4))
      if (cell && !clean(cell)) items.push(...evidence(c, cell, 4))
    }
    return [head, ...table(items), ...questions]
  }
  const out = [head]
  for (const k of cases) {
    out.push(`  ${show(lead(caseWord(k), k.label))}`)
    const sentence = slots.row(k.path)
    if (sentence) out.push(`    ${sentence}`)
    const failed = k.outcome !== 'pass'
    out.push(...cellsBody(c, kind, k.cells, 4, { failed, verbose, effects: false, slots }))
  }
  if (pooled.length) {
    const label = labeller(columns, ['harness', 'arm', 'sandbox'])
    const byKey = new Map(pooled.map((p) => [p.key, p]))
    const items: Item[] = [
      { indent: 4, cells: [kind === 'harnesses' ? 'harness' : 'arm', t('pass', c.dim)] },
    ]
    for (const col of columns) {
      const p = byKey.get(col.key)
      const effect = p ? gatedEffect(c, p) : t('')
      items.push({
        indent: 4,
        cells: [label(col), pooledCount(cases, col.key), ...(effect.text ? [effect] : [])],
      })
      if (p) items.push(...rowLine(slots, p.path, 6))
      if (p && verbose) items.push({ indent: 6, free: t(pooledStats(p, label(col)), c.dim) })
    }
    out.push(`  ${show(lead(pooledWord, 'all cases'))}`, ...table(items))
  }
  return [...out, ...questions]
}

/** The slots an eval's insight fills, or none without one. */
function slotsFor(insight: EvalInsight | null): Slots {
  if (!insight) return NO_SLOTS
  const rows = new Map((insight.rows ?? []).map((r) => [r.row, oneLine(r.text)]))
  const choose = insight.intent.job === 'choose'
  const named = (cells: CellResult[]) => {
    if (!choose) return []
    const counts = new Map<string, number>()
    for (const n of insight.namedTools ?? []) {
      if (!cells.some((cell) => n.attempt.startsWith(`${cell.path}#`))) continue
      for (const tool of new Set(n.tools.map(oneLine))) {
        counts.set(tool, (counts.get(tool) ?? 0) + 1)
      }
    }
    return [...counts]
      .map(([tool, tries]) => ({ tool, tries }))
      .sort((a, b) => b.tries - a.tries || (a.tool < b.tool ? -1 : 1))
  }
  return {
    row: (path) => rows.get(path) ?? null,
    named,
    subject: choose && insight.intent.subject.tool ? oneLine(insight.intent.subject.tool) : null,
  }
}

/** One eval's block, laid out as `layout()` says for its job, with its insight's sentences. */
export function evalBlock(
  c: Colors,
  e: EvalResult,
  verbose = false,
  insight: EvalInsight | null = null,
): string[] {
  const shape = layout(insight?.intent.job ?? 'other', e.across, e.family, false)
  const slots = slotsFor(insight)
  const answer = insight?.answer ? [`  ${oneLine(insight.answer.text)}`] : []
  const findings = (insight?.findings ?? []).map((f) => `  ${oneLine(f.text)}`)
  if (shape.family) {
    const [head = '', ...rest] = familyBlock(c, e, shape.kind, verbose, slots)
    return [head, ...answer, ...rest, ...findings]
  }
  const v = verdict(c, e)
  const name = `${e.group.length ? `${e.group.join(' › ')} › ` : ''}${e.name}`
  const head = `${show(v)}${' '.repeat(Math.max(2, HEAD - v.text.length))}${name}`
  const cells = e.cells ?? []
  if (e.todo || e.outcome === 'skipped' || !cells.length) return [head]
  const failed = e.outcome !== 'pass'
  const body = cellsBody(c, shape.kind, cells, 2, { failed, verbose, effects: true, slots })
  return [head, ...answer, ...body, ...findings, ...questionLines(c, e.questions, 2)]
}

/**
 * `5 fail · 2 pass · 1 not gated · 1 cancelled`: errors outside any eval and fails first, every
 * case counting one, zeros left out.
 */
export function tallyLine(c: Colors, tally: SuiteResult['tally']): string {
  const parts = [
    tally.errors ? c.red(plural(tally.errors, 'run error')) : '',
    tally.fail ? c.red(`${tally.fail} fail`) : '',
    tally.pass ? c.green(`${tally.pass} pass`) : '',
    tally.notGated ? c.dim(`${tally.notGated} not gated`) : '',
    tally.infraError ? c.yellow(plural(tally.infraError, 'infra error')) : '',
    tally.cancelled ? c.yellow(`${tally.cancelled} cancelled`) : '',
    tally.skipped ? c.dim(`${tally.skipped} skipped`) : '',
  ].filter(Boolean)
  return parts.length ? parts.join(c.dim(' · ')) : 'no evals ran'
}

/** Every eval's block in file-path order, then source order; a blank line around each longer one. */
export function renderBlocks(
  suite: SuiteResult,
  opts: RenderOptions,
  insights: RunInsights | null = null,
): string[] {
  const c = colors(opts.color)
  const byEval = new Map((insights?.evals ?? []).map((x) => [x.evalId, x]))
  const blocks = suite.files.flatMap((f) =>
    [...f.evals]
      .sort((a, b) => a.order - b.order)
      .map((e) => evalBlock(c, e, opts.verbose, byEval.get(e.path) ?? null)),
  )
  const out: string[] = []
  blocks.forEach((block, i) => {
    const prev = blocks[i - 1]
    if (prev && (prev.length > 1 || block.length > 1)) out.push('')
    out.push(...block)
  })
  return out
}

/** Insights for these facts: null when there are none, they failed, or they were written for other facts. */
export const freshInsights = (suite: SuiteResult, insights: RunInsights | null) =>
  insights && !insights.error && insights.factsHash === factsHash(suite) ? insights : null

/** Why a run's insights didn't print, or with `-v` what wrote them. */
function insightNotes(
  c: Colors,
  suite: SuiteResult,
  insights: RunInsights | null,
  fresh: RunInsights | null,
  verbose: boolean,
): string[] {
  if (!insights || !fromModel(insights)) return []
  if (insights.error) return [c.yellow(`insights failed (${clip(insights.error, 200)})`)]
  if (!fresh) {
    return [
      c.dim(
        `insights left out: insights.json was written for other facts than this run's; delete it and run reeval analyze ${suite.runId} --insights`,
      ),
    ]
  }
  const skipped = insights.budget?.skipped.length ?? 0
  const failed = insights.failed ?? []
  const stopped = insights.stopped
  const finish = `reeval analyze ${suite.runId} --insights to finish`
  const budget = [
    ...(skipped
      ? [
          c.yellow(
            `insights skipped for ${plural(skipped, 'eval')}: analysis.maxTokens (${formatTokens(insights.budget?.maxTokens ?? 0)}) reached — raise it in reeval.config.ts, or ${finish}`,
          ),
        ]
      : []),
    ...(failed[0]
      ? [
          c.yellow(
            `insights failed for ${plural(failed.length, 'eval')} (${clip(failed[0].error, 160)}), so they print their facts: ${finish}`,
          ),
        ]
      : []),
    ...(stopped
      ? [
          c.yellow(
            `insights stopped: ${plural(stopped.skipped.length, 'eval')} skipped (${stopped.signal === 'SIGTERM' ? 'SIGTERM' : 'Ctrl-C'}): ${finish}`,
          ),
        ]
      : []),
  ]
  if (!verbose) return budget
  const { dropped, regenerated } = insights.validation
  return [
    ...budget,
    c.dim(
      [
        `insights by ${insights.model} (${insights.promptVersion})`,
        `${plural(dropped, 'sentence')} removed`,
        ...(regenerated ? [`${regenerated} asked again`] : []),
        `${formatTokens(insights.usage.inputTokens)} in, ${formatTokens(insights.usage.outputTokens)} out${insights.usage.reasoningTokens ? ` (${formatTokens(insights.usage.reasoningTokens)} reasoning)` : ''}`,
      ].join(' · '),
    ),
  ]
}

/**
 * A run's result: its errors outside any eval, its blocks with their insights, the headline,
 * then the tally and, with no analysis model, the hint, then the remarks. Insights written for
 * other facts are left out with a note; remarks come from the record and history, not a model,
 * so they print either way.
 */
export function render(
  suite: SuiteResult,
  insights: RunInsights | null,
  opts: RenderOptions,
): string[] {
  const c = colors(opts.color)
  const fresh = freshInsights(suite, insights)
  const blocks = renderBlocks(suite, opts, fresh)
  return [
    ...suite.errors.flatMap((error) => [c.red(`error: ${error}`), '']),
    ...blocks,
    ...(blocks.length ? [''] : []),
    ...(fresh?.headline ? [oneLine(fresh.headline.text)] : []),
    ...insightNotes(c, suite, insights, fresh, opts.verbose),
    ...(opts.notes ?? []),
    tallyLine(c, suite.tally),
    ...(opts.hint ? [NO_MODEL_HINT] : []),
    ...remarkLines(c, suite, insights, opts.verbose),
  ]
}
