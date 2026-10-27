// Per-key judge rates and collapsed score/threshold lines for the run summary and studio.
// Display only: the attempt still fails if any judge fails, and the record is unchanged.
import type {
  AttemptRecord,
  CellRecord,
  EvalEntry,
  JudgmentRecord,
  Lift,
} from '../history/types.ts'
import { containsZero, EFFECT_MIN_COUNTED, liftInterval, round3 } from '../stats.ts'
import { clip } from '../text.ts'
import type { TokenUsage } from '../types.ts'
import { sumUsage } from '../usage.ts'

/** Show each key until this many; then the minimum score plus a count. */
const COLLAPSE_AFTER = 2

const counted = (a: Pick<AttemptRecord, 'outcome'>) => a.outcome === 'pass' || a.outcome === 'fail'

/** Short names stay at this many characters; a collision takes the distinctive tail instead. */
const LABEL_MAX = 20

const judgeText = (question: string) => question.replace(/\?+$/, '').trim()

/** Last `max` characters, cut at a word boundary where there is one, marked with a leading `…`. */
function clipTail(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(-(max - 1))
  const space = cut.search(/\s/)
  const body = space >= 0 && space < max / 2 ? cut.slice(space + 1) : cut
  return `…${body.trimStart()}`
}

/** Short name for a judge question, e.g. `login` from `login?`. */
export function judgeLabel(question: string): string {
  return clip(judgeText(question), LABEL_MAX)
}

/**
 * One short label per key. Shared prefixes take the distinctive tail so
 * `Does this change…` does not collapse several checks; a tail that still
 * collides falls back to the key.
 */
export function uniqueJudgeLabels(
  items: readonly { key: string; question: string }[],
): Map<string, string> {
  const first = new Map<string, { key: string; question: string }>()
  for (const item of items) {
    if (!first.has(item.key)) first.set(item.key, item)
  }
  const labels = new Map<string, string>()
  const used = new Map<string, string[]>()

  const setLabel = (key: string, label: string) => {
    const prev = labels.get(key)
    if (prev !== undefined) {
      const group = used.get(prev)
      if (group) {
        const next = group.filter((k) => k !== key)
        if (next.length) used.set(prev, next)
        else used.delete(prev)
      }
    }
    labels.set(key, label)
    const group = used.get(label) ?? []
    group.push(key)
    used.set(label, group)
  }

  for (const row of first.values()) setLabel(row.key, judgeLabel(row.question))

  for (const [label, keys] of [...used]) {
    if (keys.length < 2) continue
    const tails = new Map<string, string[]>()
    for (const key of keys) {
      const row = first.get(key)
      if (!row) continue
      const tail = clipTail(judgeText(row.question), LABEL_MAX)
      const group = tails.get(tail) ?? []
      group.push(key)
      tails.set(tail, group)
    }
    for (const [tail, tkeys] of tails) {
      const [only] = tkeys
      const taken = (used.get(tail) ?? []).some((k) => !tkeys.includes(k))
      if (only && tkeys.length === 1 && tail !== label && !taken) setLabel(only, tail)
      else for (const key of tkeys) setLabel(key, key)
    }
  }

  for (const [, keys] of [...used]) {
    if (keys.length < 2) continue
    for (const key of keys) setLabel(key, key)
  }

  return labels
}

export type JudgeKeyRate = {
  key: string
  /** The `expect` label when the judge had one, else a short name from its question. */
  label: string
  /** Named by an `expect` label, so the cell's checks carry it too. */
  labelled: boolean
  question: string
  pass: number
  counted: number
  /** Compact lift vs the paired control, only when both sides have enough counted. */
  lift: Pick<Lift, 'points' | 'control' | 'variant' | 'withinNoise'> | null
}

type KeyTally = {
  label: string
  labelled: boolean
  question: string
  pass: number
  counted: number
}

function keyTallies(e: Pick<EvalEntry, 'attempts'>, cellKey: string): Map<string, KeyTally> {
  const byKey = new Map<string, KeyTally>()
  const expectLabels = new Map<string, string>()
  for (const a of e.attempts) {
    if (a.cell !== cellKey || !counted(a)) continue
    for (const { judgment: j, label, labelled: labeled } of labeledJudgments(a)) {
      const row = byKey.get(j.key) ?? {
        label: '',
        labelled: false,
        question: j.question,
        pass: 0,
        counted: 0,
      }
      row.counted++
      if (j.verdict === 'pass') row.pass++
      byKey.set(j.key, row)
      if (labeled && !expectLabels.has(j.key)) expectLabels.set(j.key, label)
    }
  }
  const labels = uniqueJudgeLabels(
    [...byKey].map(([key, row]) => ({ key, question: row.question })),
  )
  for (const [key, row] of byKey) {
    const label = expectLabels.get(key)
    row.labelled = label !== undefined
    row.label = label ?? labels.get(key) ?? judgeLabel(row.question)
  }
  return byKey
}

function pairedControl(e: Pick<EvalEntry, 'cells'>, cellKey: string): CellRecord | undefined {
  const cell = e.cells.find((c) => c.key === cellKey)
  if (cell?.role !== 'variant') return undefined
  return e.cells.find(
    (x) => x.role === 'control' && x.harness === cell.harness && x.sandbox === cell.sandbox,
  )
}

function liftForKey(
  variant: { pass: number; counted: number },
  control: { pass: number; counted: number } | undefined,
): JudgeKeyRate['lift'] {
  if (!control || variant.counted < EFFECT_MIN_COUNTED || control.counted < EFFECT_MIN_COUNTED) {
    return null
  }
  const { points, low, high } = liftInterval(
    { pass: variant.pass, n: variant.counted },
    { pass: control.pass, n: control.counted },
  )
  return {
    points: round3(points),
    control: { pass: control.pass, counted: control.counted },
    variant: { pass: variant.pass, counted: variant.counted },
    withinNoise: containsZero(low, high),
  }
}

/** Per-key pass/counted for one cell's counted attempts, with lift on a variant when both sides qualify. */
export function cellJudgeRates(
  e: Pick<EvalEntry, 'attempts' | 'cells'>,
  cellKey: string,
): JudgeKeyRate[] {
  const tallies = keyTallies(e, cellKey)
  const control = pairedControl(e, cellKey)
  const controlTallies = control ? keyTallies(e, control.key) : undefined
  return [...tallies].map(([key, row]) => ({
    key,
    ...row,
    lift: liftForKey(row, controlTallies?.get(key)),
  }))
}

/**
 * The judge rates a cell's summary line adds to its checks: a labeled judge whose label is one
 * of the cell's checks against its control is already there.
 */
export function summaryJudgeRates(
  e: Pick<EvalEntry, 'attempts' | 'cells'>,
  cell: Pick<CellRecord, 'key' | 'checks'>,
): JudgeKeyRate[] {
  const checked = new Set(
    (cell.checks ?? []).filter((k) => k.control && k.verdict).map((k) => k.label),
  )
  return cellJudgeRates(e, cell.key).filter((r) => !(r.labelled && checked.has(r.label)))
}

const signedPoints = (x: number) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}`

/** `login 4/5 · checkout 0/5`, with `(+80 pts)` on a key that has lift. */
export function judgeRatesLabel(rates: readonly JudgeKeyRate[]): string {
  return rates
    .map((r) => {
      const n = `${r.label} ${r.pass}/${r.counted}`
      return r.lift ? `${n} (${signedPoints(r.lift.points)} pts)` : n
    })
    .join(' · ')
}

export type CollapsedJudge = {
  verdict: 'pass' | 'fail'
  score: number
  threshold: number
  label: string
  key: string
}

/** Each key, or the lowest score plus how many judges there were. */
export function collapsedJudges(judgments: readonly JudgmentRecord[]): {
  shown: CollapsedJudge[]
  extra: number
} {
  const labels = uniqueJudgeLabels(judgments)
  const items = judgments.map((j) => ({
    verdict: j.verdict,
    score: j.score,
    threshold: j.threshold,
    label: labels.get(j.key) ?? judgeLabel(j.question),
    key: j.key,
  }))
  if (items.length <= COLLAPSE_AFTER) return { shown: items, extra: 0 }
  const min = items.reduce((a, b) => (a.score <= b.score ? a : b))
  return { shown: [min], extra: items.length }
}

/** `fail 0.78/0.80`, or `fail 0.33/0.80 · 3 judges` when there are many. */
export function collapsedJudgeLabel(judgments: readonly JudgmentRecord[]): string | null {
  if (!judgments.length) return null
  const { shown, extra } = collapsedJudges(judgments)
  const parts = shown.map((j) => `${j.verdict} ${j.score.toFixed(2)}/${j.threshold.toFixed(2)}`)
  if (extra) parts.push(`${extra} judges`)
  return parts.join(' · ')
}

const JUDGE_ERROR = /^judge failed for /

/**
 * Each judgment's `expect` label, by position: the attempt's `toPass` assertions (less those on a
 * failed judge call, which recorded no judgment) in call order, when they are exactly as many as
 * its judgments. `check` is that assertion's label, the key of its check; a judgment no label
 * reaches is named by its question.
 */
export function labeledJudgments(
  a: Pick<AttemptRecord, 'judgements' | 'assertions'>,
): Array<{ judgment: JudgmentRecord; label: string; labelled: boolean; check?: string }> {
  const passes = (a.assertions ?? []).filter(
    (x) => /(^|\.)toPass$/.test(x.matcher) && !JUDGE_ERROR.test(x.message ?? ''),
  )
  const zip = passes.length === a.judgements.length
  return a.judgements.map((judgment, i) => {
    const x = zip ? passes[i] : undefined
    return {
      judgment,
      label: x?.labelled ? x.label : judgeText(judgment.question),
      labelled: x?.labelled === true,
      ...(x ? { check: x.label } : {}),
    }
  })
}

/** Sum of counted attempts' usage; null when none of them reported any. */
export function cellUsage(e: Pick<EvalEntry, 'attempts'>, cellKey: string): TokenUsage | null {
  return sumUsage(e.attempts.filter((a) => a.cell === cellKey && counted(a)).map((a) => a.usage))
}

/**
 * Each `c.exec` check's `expect` label, by position: the attempt's `toSucceed` assertions in call
 * order, when they are exactly as many as its checks; undefined where no label reaches.
 */
export function checkLabels(
  a: Pick<AttemptRecord, 'checks' | 'assertions'>,
): Array<string | undefined> {
  const succeeds = (a.assertions ?? []).filter((x) => /(^|\.)toSucceed$/.test(x.matcher))
  const zip = succeeds.length === a.checks.length
  return a.checks.map((_, i) => {
    const x = zip ? succeeds[i] : undefined
    return x?.labelled ? x.label : undefined
  })
}

/**
 * Each `toSucceed` label's `c.exec` check, by position, when the attempt's `toSucceed` assertions
 * are exactly as many as its checks; empty otherwise.
 */
export function checksByLabel<C>(
  a: { checks: readonly C[] } & Pick<AttemptRecord, 'assertions'>,
): Map<string, C> {
  const succeeds = (a.assertions ?? []).filter((x) => /(^|\.)toSucceed$/.test(x.matcher))
  if (succeeds.length !== a.checks.length) return new Map()
  return new Map(succeeds.map((x, i) => [x.label, a.checks[i] as C]))
}

/**
 * How a `c.exec` given `retries` ended: `passed on try 2 of 3`, `failed all 3 tries`, or null
 * when it had none or passed on its first try.
 */
export function triesNote(exitCode: number, tried: number, of: number): string | null {
  if (of <= 1 || (exitCode === 0 && tried <= 1)) return null
  if (exitCode === 0) return `passed on try ${tried} of ${of}`
  return tried >= of ? `failed all ${of} tries` : `failed on try ${tried} of ${of}`
}

/** {@link triesNote} for a recorded check. */
export const checkTries = (c: {
  exitCode: number
  retries?: number
  tries?: readonly unknown[]
}) => (c.retries && c.tries ? triesNote(c.exitCode, c.tries.length, c.retries + 1) : null)

/** A check's command on one line: the first non-empty line, clipped; its log has the rest. */
export function commandLine(command: string, max = 80): string {
  const lines = command
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return clip(lines.length > 1 ? `${lines[0]} …` : (lines[0] ?? ''), max)
}
