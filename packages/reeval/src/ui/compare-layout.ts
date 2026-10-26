// `reeval compare`'s layout, catch regressions: a block per eval that changed between two runs, in
// file-path then source order, with each run of unchanged evals collapsed to `+N same`, then the
// tally. A regressed eval lists the checks that flipped; a fixed one, the checks that now pass; one
// that can't be compared names the part that changed. An eval whose gate changed names both gates
// and how base would score under head's, and isn't collapsed. Pure and deterministic, from the two
// runs' SuiteResults and compare rows; statistics print only with `verbose`.
import type { HistoryCell, RunRecord } from '../history/types.ts'
import { fenced, plural } from '../text.ts'
import {
  type CompareCell,
  type CompareFamilyLift,
  type CompareRow,
  type CompareStatus,
  rowKey,
  type StackChange,
} from '../view/compare.ts'
import { effortChangeLabel } from '../view/effort.ts'
import {
  type CaseResult,
  type CellResult,
  type CheckResult,
  type EvalResult,
  isStudy,
  type ResultOutcome,
  type SuiteResult,
} from '../view/suite.ts'
import { type Colors, colors, type Paint } from './colors.ts'
import {
  assertionOf,
  checkCount,
  checkLabel,
  errorKind,
  errorText,
  evalBlock,
  HEAD,
  type Item,
  labeller,
  renderBlocks,
  show,
  type Text,
  t,
  table,
} from './layout.ts'

/** One side of a compare: its run id, its facts, and where its commit stands. */
export type CompareSide = {
  runId: string
  suite: SuiteResult
  /** Its commit isn't in HEAD's history (rebased or dropped). */
  unreachable?: boolean
  /** How the run ended; one that didn't finish has evals that never ran to the end. */
  status?: RunRecord['status']
}

export type CompareInput = {
  /** Null when head has no earlier recorded run to compare with. */
  base: CompareSide | null
  head: CompareSide
  rows: CompareRow[]
  /** What changed in the stack between the runs (`stackChanges`). */
  changes: StackChange[]
}

export type CompareOptions = {
  color: boolean
  /** `-v`: each cell's lift and effort, base → head, and every stack change. */
  verbose: boolean
}

const WORD: Record<CompareStatus, string> = {
  regressed: 'regressed',
  fixed: 'fixed',
  gate: 'gate changed',
  drift: "can't compare",
  infra: 'infra error',
  added: 'new',
  removed: 'removed',
  same: 'same',
}

/** The tally's order: what needs a look first. */
const TALLY: CompareStatus[] = [
  'regressed',
  'fixed',
  'drift',
  'gate',
  'infra',
  'added',
  'removed',
  'same',
]

const paintStatus = (c: Colors, s: CompareStatus): Paint =>
  s === 'regressed' ? c.red : s === 'fixed' ? c.green : s === 'same' ? c.dim : c.yellow

/** A side's outcome as its row reads it: a study's pass is `not_gated`. */
type Shown = ResultOutcome | 'not_gated'

const OUTCOME: Record<Shown, string> = {
  pass: 'pass',
  not_gated: 'not gated',
  fail: 'fail',
  infra_error: 'infra error',
  cancelled: 'cancelled',
  skipped: 'skipped',
}

const paintOutcome = (c: Colors, o: Shown): Paint =>
  o === 'pass'
    ? c.green
    : o === 'fail'
      ? c.red
      : o === 'infra_error' || o === 'cancelled'
        ? c.yellow
        : c.dim

/** One side's outcome as `reeval show` reads it: a fail the interrupt caused is `cancelled`. */
const sideOutcome = (row: CompareRow, side: 'base' | 'head'): ResultOutcome | null =>
  row.cancelled?.includes(side) ? 'cancelled' : row[side]

/** One side's outcome as its eval's row in `reeval run` reads it: a study's pass is `not gated`. */
const shownOutcome = (row: CompareRow, side: 'base' | 'head', unit?: Unit): Shown | null => {
  const o = sideOutcome(row, side)
  return o === 'pass' && isStudy(unit?.result.cells ?? []) ? 'not_gated' : o
}

/** An eval, one case of a family, or the family itself, as compare rows name it: by its id. */
type Unit = { file: string; result: EvalResult }

/**
 * Every eval and family case in a run, by eval id, in file-path then source order, each family
 * after its cases by its own id. A case is given as an eval of its own, its name the family's with
 * the case filled in.
 */
function unitsOf(suite: SuiteResult): Map<string, Unit> {
  const out = new Map<string, Unit>()
  for (const file of suite.files) {
    for (const e of [...file.evals].sort((a, b) => a.order - b.order)) {
      if (!e.cases) {
        out.set(e.id, { file: file.path, result: e })
        continue
      }
      for (const k of e.cases) out.set(k.id, { file: file.path, result: caseAsEval(e, k) })
      out.set(rowKey({ id: e.id, kind: 'family' }), { file: file.path, result: e })
    }
  }
  return out
}

const caseAsEval = (family: EvalResult, k: CaseResult): EvalResult => ({
  ...family,
  path: k.path,
  id: k.id,
  name: k.name,
  template: null,
  order: k.order,
  family: false,
  outcome: k.outcome,
  cells: k.cells,
  cases: null,
  pooled: null,
  questions: [],
})

type Units = { base: Map<string, Unit>; head: Map<string, Unit> }

/**
 * The rows file by file, in head's source order, each eval only base has placed after the eval
 * before it in base's, so a removed eval sits where it was (beside the one renamed from it).
 */
function ordered(rows: CompareRow[], units: Units): Array<{ row: CompareRow; unit?: Unit }> {
  const byId = new Map(rows.map((r) => [rowKey(r), r]))
  const all = [...units.head.values(), ...units.base.values()]
  const files = [...new Set(all.map((u) => u.file))].sort()
  const out: Array<{ row: CompareRow; unit?: Unit }> = []
  for (const file of files) {
    const inFile = (side: Map<string, Unit>) =>
      [...side].filter(([id, u]) => u.file === file && byId.has(id))
    const ids = inFile(units.head).map(([id]) => id)
    let at = -1
    for (const [id] of inFile(units.base)) {
      const i = ids.indexOf(id)
      if (i >= 0) at = i
      else ids.splice(++at, 0, id)
    }
    for (const id of ids) {
      const unit = units.head.get(id) ?? units.base.get(id)
      out.push({ row: byId.get(id) as CompareRow, ...(unit ? { unit } : {}) })
    }
  }
  const seen = new Set(out.map((e) => rowKey(e.row)))
  for (const row of rows) if (!seen.has(rowKey(row))) out.push({ row })
  return out
}

const nameOf = (row: CompareRow, unit: Unit | undefined) => {
  const all = row.kind === 'family' ? ' (all cases)' : ''
  if (!unit) return `${row.id}${all}`
  const e = unit.result
  return `${e.group.length ? `${e.group.join(' › ')} › ` : ''}${e.name}${all}`
}

const headLine = (word: Text, name: string) =>
  `${show(word)}${' '.repeat(Math.max(2, HEAD - word.text.length))}${name}`

type CheckState = 'pass' | 'fail' | 'not run'

/**
 * A check's state in one cell. A comparable eval runs the same checks on both sides, so a check
 * the cell never recorded is one no attempt reached: not run, never a failure.
 */
function stateOf(k: CheckResult | undefined): CheckState {
  if (!k || k.outcome.status === 'not run') return 'not run'
  return k.outcome.failed + k.outcome.errored > 0 ? 'fail' : 'pass'
}

/** A check's side of a flip: its state, or its counts when a side answered it more than once. */
function sideText(k: CheckResult | undefined, counts: boolean): string {
  const state = stateOf(k)
  return counts && k && state !== 'not run' ? checkCount(k, false) : state
}

const answered = (k: CheckResult | undefined) =>
  k?.outcome.status === 'ran' ? k.outcome.passed + k.outcome.failed + k.outcome.errored : 0

/** Every check label either cell has, head's first. */
const labelsOf = (base: CellResult, head: CellResult) => [
  ...new Set([...head.checks, ...base.checks].map((k) => k.label)),
]

/**
 * A regressed cell: each check head didn't pass, as `pass → fail` (with its assertion) or `not
 * run`, then the errors no check explains and how many more passed.
 */
function regressedItems(c: Colors, base: CellResult, head: CellResult, indent: number): Item[] {
  const items: Item[] = []
  let passed = 0
  for (const label of labelsOf(base, head)) {
    const h = head.checks.find((k) => k.label === label)
    const b = base.checks.find((k) => k.label === label)
    const state = stateOf(h)
    if (state === 'pass') {
      passed++
      continue
    }
    if (state === 'not run') {
      items.push({ indent, cells: [checkLabel(label), t('not run', c.dim)] })
      continue
    }
    const counts = answered(h) > 1 || answered(b) > 1
    const was = stateOf(b) === 'fail' && !counts ? null : sideText(b, counts)
    const now = sideText(h, counts)
    items.push({
      indent,
      cells: [checkLabel(label), t(was ? `${was} → ${now}` : now, c.red)],
    })
    const assertion = h ? assertionOf(h) : ''
    if (assertion) items.push({ indent: indent + 2, free: t(assertion, c.dim) })
  }
  for (const err of head.errors) {
    items.push({ indent, cells: [errorKind(err), t(errorText(err), c.dim)] })
  }
  if (passed && items.length) items.push({ indent, free: t(`+${passed} more passed`, c.dim) })
  return items
}

/** A fixed cell: each check that passes now and didn't before, as `fail → pass` or `not run → pass`. */
function fixedItems(c: Colors, base: CellResult, head: CellResult, indent: number): Item[] {
  const items: Item[] = []
  for (const label of labelsOf(base, head)) {
    const h = head.checks.find((k) => k.label === label)
    const b = base.checks.find((k) => k.label === label)
    if (stateOf(h) !== 'pass' || stateOf(b) === 'pass') continue
    const counts = answered(h) > 1 || answered(b) > 1
    items.push({
      indent,
      cells: [checkLabel(label), t(`${sideText(b, counts)} → ${sideText(h, counts)}`, c.green)],
    })
  }
  return items
}

/** The cells both runs ran, as `[base, head]`; under a heading each when there's more than one. */
function flips(
  c: Colors,
  base: EvalResult,
  head: EvalResult,
  rows: (b: CellResult, h: CellResult, indent: number) => Item[],
): Item[] {
  const before = new Map((base.cells ?? []).map((x) => [x.key, x]))
  const pairs = (head.cells ?? []).flatMap((h): Array<[CellResult, CellResult]> => {
    const b = before.get(h.key)
    return b ? [[b, h]] : []
  })
  if (pairs.length === 1) {
    const [b, h] = pairs[0] as [CellResult, CellResult]
    return rows(b, h, 2)
  }
  const label = labeller(
    pairs.map(([, h]) => h),
    ['harness', 'arm', 'sandbox'],
  )
  return pairs.flatMap(([b, h]) => {
    const items = rows(b, h, 4)
    return items.length ? [{ indent: 2, free: t(label(h), c.dim) }, ...items] : []
  })
}

const idRow = (c: Colors, side: 'base' | 'head', id: string, outcome?: Shown | null): Item => ({
  indent: 2,
  cells: [side, id, ...(outcome ? [t(OUTCOME[outcome], paintOutcome(c, outcome))] : [])],
})

/**
 * `gate  passRate 0.5 → all  base would fail under it`: a changed gate, and base's outcome with
 * its recorded attempts scored under head's gate.
 */
function gateRows(c: Colors, row: CompareRow): Item[] {
  if (!row.gate) return []
  const { base, head, rescored } = row.gate
  const still = rescored === row.base ? 'still ' : ''
  const note = `base would ${still}${OUTCOME[rescored]} under it`
  return [{ indent: 2, cells: ['gate', `${base} → ${head}`, t(note, c.dim)] }]
}

/** `environment`, `evals/helpers.ts`: what made an eval not comparable, as the row says it. */
function changedParts(row: CompareRow, changes: StackChange[]): string {
  const parts = (row.changes ?? []).map((p) => p.replace(/ changed$/, ''))
  if (parts.length) return parts.join(', ')
  return changes
    .filter((x) => x.outsideFingerprint)
    .map((x) => x.label)
    .join(', ')
}

/**
 * The cells only one run ran, when the runs ran different cells of the eval; on a family, the
 * variants whose pooled lift only one run has.
 */
function cellRows(row: CompareRow): Item[] {
  const noun = row.kind === 'family' ? 'variants' : 'cells'
  return [
    ...(row.cells?.added.length
      ? [{ indent: 2, cells: [`${noun} added`, row.cells.added.join(', ')] }]
      : []),
    ...(row.cells?.removed.length
      ? [{ indent: 2, cells: [`${noun} removed`, row.cells.removed.join(', ')] }]
      : []),
  ]
}

/** The eval's own rows as `reeval run` prints them under its head: its evidence when it failed. */
const resultBody = (c: Colors, e: EvalResult | undefined) =>
  e && e.outcome !== 'pass' ? evalBlock(c, e).slice(1) : []

const liftShort = (l: HistoryCell['lift'] | undefined) =>
  l ? `${signed(l.points)} (${signed(l.lo)}…${signed(l.hi)})${l.withinNoise ? ' noise' : ''}` : '–'
const signed = (x: number) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}`

type PooledSide = NonNullable<CompareFamilyLift['base']>

const pooledShort = (l: PooledSide | null) =>
  l ? `${signed(l.points)} (${signed(l.lo)}…${signed(l.hi)})` : '–'

/**
 * A family row's gated variants: each pooled lift, base → head, and the `minLift` a side's low end
 * fell short of, red when head's did and green when only base's did.
 */
function pooledItems(c: Colors, row: CompareRow): Item[] {
  return (row.lifts ?? []).flatMap((l) => {
    const minLift = l.head?.minLift ?? l.base?.minLift
    if (minLift === undefined) return []
    const sides =
      row.status === 'added'
        ? pooledShort(l.head)
        : row.status === 'removed'
          ? pooledShort(l.base)
          : `${pooledShort(l.base)} → ${pooledShort(l.head)}`
    const failed = row.status === 'removed' ? l.base?.outcome : l.head?.outcome
    const paint = failed === 'fail' ? c.red : l.base?.outcome === 'fail' && l.head ? c.green : c.dim
    const short = failed === 'fail' ? `, not by minLift ${Math.round(minLift * 100)}` : ''
    return [{ indent: 2, cells: [l.key, t(`lift ${sides}${short}`, paint)] }]
  })
}

/** `-v`: a cell's lift and effort, base → head. */
function cellStats(cell: CompareCell): string {
  const lift =
    cell.base.lift || cell.head.lift
      ? `lift ${liftShort(cell.base.lift)} → ${liftShort(cell.head.lift)}`
      : ''
  const effort =
    cell.base.effort && cell.head.effort
      ? effortChangeLabel(cell.base.effort, cell.head.effort)
      : ''
  return [lift, effort].filter(Boolean).join(' · ')
}

function statsRows(c: Colors, row: CompareRow): Item[] {
  return (row.perCell ?? []).flatMap((cell) => {
    const stats = cellStats(cell)
    return stats ? [{ indent: 2, cells: [cell.key, t(stats, c.dim)] }] : []
  })
}

type Block = { lines: string[]; ids: boolean }

function block(
  c: Colors,
  input: CompareInput,
  units: Units,
  { row, unit }: { row: CompareRow; unit?: Unit },
  opts: CompareOptions,
): Block {
  const base = units.base.get(rowKey(row))?.result
  const head = units.head.get(rowKey(row))?.result
  const word = t(WORD[row.status], paintStatus(c, row.status))
  const top = headLine(word, nameOf(row, unit))
  const baseId = input.base?.runId ?? ''
  const headId = input.head.runId
  const stats = opts.verbose ? statsRows(c, row) : []
  const family = row.kind === 'family'
  if (row.status === 'regressed' || row.status === 'fixed') {
    const evidence = family
      ? pooledItems(c, row)
      : base && head
        ? flips(c, base, head, (b, h, indent) =>
            row.status === 'regressed'
              ? regressedItems(c, b, h, indent)
              : fixedItems(c, b, h, indent),
          )
        : []
    const ids = row.status === 'regressed'
    const items: Item[] = [
      ...(ids ? [idRow(c, 'base', baseId), idRow(c, 'head', headId)] : []),
      ...cellRows(row),
      ...evidence,
    ]
    return { lines: [top, ...table(gateRows(c, row)), ...table(items), ...table(stats)], ids }
  }
  if (row.status === 'gate') {
    const lines = [
      top,
      ...table(gateRows(c, row)),
      ...table([
        idRow(c, 'base', baseId, shownOutcome(row, 'base', units.base.get(rowKey(row)))),
        idRow(c, 'head', headId, shownOutcome(row, 'head', units.head.get(rowKey(row)))),
      ]),
      ...table([...cellRows(row), ...stats]),
      ...resultBody(c, head),
    ]
    return { lines, ids: true }
  }
  if (row.status === 'drift' || row.status === 'infra') {
    const changed = row.status === 'drift' ? changedParts(row, input.changes) : ''
    const lines = [
      top,
      ...(changed ? table([{ indent: 2, cells: ['changed', changed] }]) : []),
      ...table([
        idRow(c, 'base', baseId, shownOutcome(row, 'base', units.base.get(rowKey(row)))),
        idRow(c, 'head', headId, shownOutcome(row, 'head', units.head.get(rowKey(row)))),
      ]),
      ...table([...cellRows(row), ...stats, ...(family ? pooledItems(c, row) : [])]),
      ...(family ? [] : resultBody(c, head)),
    ]
    return { lines, ids: true }
  }
  if (row.status === 'added') {
    return {
      lines: [
        top,
        ...table([
          idRow(c, 'head', headId, shownOutcome(row, 'head', units.head.get(rowKey(row)))),
          ...(family ? pooledItems(c, row) : []),
        ]),
        ...(family ? [] : resultBody(c, head)),
      ],
      ids: true,
    }
  }
  if (row.status === 'removed') {
    return {
      lines: [
        top,
        ...table([
          idRow(c, 'base', baseId, shownOutcome(row, 'base', units.base.get(rowKey(row)))),
          ...(family ? pooledItems(c, row) : []),
        ]),
      ],
      ids: true,
    }
  }
  return { lines: [top, ...table(gateRows(c, row)), ...table(stats)], ids: false }
}

/** `1 regressed · 1 fixed · 1 can't compare · 4 same`: what needs a look first, zeros left out. */
export function compareTally(c: Colors, rows: CompareRow[]): string {
  const parts = TALLY.flatMap((s) => {
    const n = rows.filter((r) => r.status === s).length
    return n ? [paintStatus(c, s)(`${n} ${WORD[s]}`)] : []
  })
  return parts.length ? parts.join(c.dim(' · ')) : 'no evals to compare'
}

const UNFINISHED: Partial<Record<RunRecord['status'], string>> = {
  interrupted: 'was interrupted, so some of its evals were cancelled before they finished',
  budget: 'stopped at its duration budget, so some of its evals never ran',
}

/** What makes the compare suspect: a run whose commit isn't in HEAD's history, or that didn't finish. */
function sideNotes(c: Colors, input: CompareInput): string[] {
  return (['base', 'head'] as const).flatMap((side) => {
    const s = input[side]
    if (!s) return []
    const unfinished = s.status && UNFINISHED[s.status]
    return [
      ...(s.unreachable
        ? [`${side} ${s.runId} ran on a commit that isn't in HEAD's history (rebased or dropped?)`]
        : []),
      ...(unfinished ? [`${side} ${s.runId} ${unfinished}`] : []),
    ].map((note) => c.yellow(note))
  })
}

function stackNotes(c: Colors, changes: StackChange[]): string[] {
  return changes.map((x) => c.dim(`stack changed: ${x.label} ${x.base} → ${x.head}`))
}

/** Head on its own: no earlier recorded run, so every eval is new, shown as `reeval run` shows it. */
function noBaseline(c: Colors, input: CompareInput, opts: CompareOptions): string[] {
  const { suite, runId } = input.head
  const blocks = renderBlocks(suite, { color: opts.color, verbose: opts.verbose })
  const units = unitsOf(suite)
  const order = ['fail', 'infra_error', 'cancelled', 'pass', 'not_gated', 'skipped'] as const
  const tally = (rows: CompareRow[], noun: string) => {
    const shown = rows.map((r) => shownOutcome(r, 'head', units.get(rowKey(r))))
    const counts = order.flatMap((o) => {
      const n = shown.filter((x) => x === o).length
      return n ? [paintOutcome(c, o)(`${n} ${OUTCOME[o]}`)] : []
    })
    return `${plural(rows.length, noun)}${counts.length ? ` (${counts.join(c.dim(' · '))})` : ''}`
  }
  const families = input.rows.filter((r) => r.kind === 'family')
  return [
    `No earlier recorded run to compare ${runId} with, so every eval is new.`,
    ...(blocks.length ? ['', ...blocks] : []),
    '',
    ...sideNotes(c, input),
    [
      tally(
        input.rows.filter((r) => r.kind !== 'family'),
        'new eval',
      ),
      ...(families.length ? [tally(families, 'pooled gate')] : []),
    ].join(c.dim(' · ')),
  ]
}

/** `reeval compare`'s lines: the blocks, a blank line around each, then the tally. */
export function renderCompare(input: CompareInput, opts: CompareOptions): string[] {
  const c = colors(opts.color)
  if (!input.base) return noBaseline(c, input, opts)
  const units = { base: unitsOf(input.base.suite), head: unitsOf(input.head.suite) }
  const blocks: string[][] = []
  let ids = false
  let same = 0
  const flush = () => {
    if (same) blocks.push([c.dim(`+${same} same`)])
    same = 0
  }
  for (const entry of ordered(input.rows, units)) {
    const shown = entry.row.gate || (opts.verbose && entry.row.perCell?.length)
    if (entry.row.status === 'same' && !shown) {
      same++
      continue
    }
    flush()
    const b = block(c, input, units, entry, opts)
    ids ||= b.ids
    blocks.push(b.lines)
  }
  flush()
  if (!ids) {
    blocks.unshift(
      table(
        [
          { indent: 0, cells: ['base', input.base.runId] },
          { indent: 0, cells: ['head', input.head.runId] },
        ],
        HEAD - 2,
      ),
    )
  }
  const notes = [...sideNotes(c, input), ...(opts.verbose ? stackNotes(c, input.changes) : [])]
  return [...blocks.flatMap((b) => [...b, '']), ...notes, compareTally(c, input.rows)]
}

/** `reeval compare --md`: a heading with both run ids, and the layout in a text block. */
export function renderCompareMarkdown(input: CompareInput, opts: CompareOptions): string {
  const title = input.base
    ? `### reeval compare: ${input.head.runId} vs ${input.base.runId}`
    : `### reeval compare: ${input.head.runId}`
  return [title, '', ...fenced(renderCompare(input, { ...opts, color: false }), 'text'), ''].join(
    '\n',
  )
}
