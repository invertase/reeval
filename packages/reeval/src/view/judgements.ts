// Per-key judge rates and collapsed score/threshold lines for the run summary and studio.
// Display only: the attempt still fails if any judge fails, and the record is unchanged.
import type {
  AttemptRecord,
  CellRecord,
  EvalEntry,
  JudgementRecord,
  Lift,
} from '../history/types.ts'
import { liftInterval, round3 } from '../stats.ts'
import { clip } from '../text.ts'
import type { TokenUsage } from '../types.ts'
import { sumUsage } from '../usage.ts'

/**
 * Fewest counted attempts on each side for a lift that can exclude 0 (2/2 vs 0/2).
 * Same floor as analyse's insufficient lift.
 */
export const LIFT_MIN_COUNTED = 2

/** Show each key until this many; then the minimum score plus a count. */
const COLLAPSE_AFTER = 2

const counted = (a: Pick<AttemptRecord, 'outcome'>) => a.outcome === 'pass' || a.outcome === 'fail'

/** Short name for a judge question, e.g. `login` from `login?`. */
export function judgeLabel(question: string): string {
  const text = question.replace(/\?+$/, '').trim()
  return clip(text, 20)
}

export type JudgeKeyRate = {
  key: string
  label: string
  question: string
  pass: number
  counted: number
  /** Compact lift vs the paired control, only when both sides have enough counted. */
  lift: Pick<Lift, 'points' | 'control' | 'variant' | 'withinNoise'> | null
}

type KeyTally = { label: string; question: string; pass: number; counted: number }

function keyTallies(e: Pick<EvalEntry, 'attempts'>, cellKey: string): Map<string, KeyTally> {
  const byKey = new Map<string, KeyTally>()
  for (const a of e.attempts) {
    if (a.cell !== cellKey || !counted(a)) continue
    for (const j of a.judgements) {
      const row = byKey.get(j.key) ?? {
        label: judgeLabel(j.question),
        question: j.question,
        pass: 0,
        counted: 0,
      }
      row.counted++
      if (j.verdict === 'pass') row.pass++
      byKey.set(j.key, row)
    }
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
  if (!control || variant.counted < LIFT_MIN_COUNTED || control.counted < LIFT_MIN_COUNTED) {
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
    withinNoise: low < 0 && high > 0,
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
export function collapsedJudges(judgements: readonly JudgementRecord[]): {
  shown: CollapsedJudge[]
  extra: number
} {
  const items = judgements.map((j) => ({
    verdict: j.verdict,
    score: j.score,
    threshold: j.threshold,
    label: judgeLabel(j.question),
    key: j.key,
  }))
  if (items.length <= COLLAPSE_AFTER) return { shown: items, extra: 0 }
  const min = items.reduce((a, b) => (a.score <= b.score ? a : b))
  return { shown: [min], extra: items.length }
}

/** `fail 0.78/0.80`, or `fail 0.33/0.80 · 3 judges` when there are many. */
export function collapsedJudgeLabel(judgements: readonly JudgementRecord[]): string | null {
  if (!judgements.length) return null
  const { shown, extra } = collapsedJudges(judgements)
  const parts = shown.map((j) => `${j.verdict} ${j.score.toFixed(2)}/${j.threshold.toFixed(2)}`)
  if (extra) parts.push(`${extra} judges`)
  return parts.join(' · ')
}

/** Sum of counted attempts' usage; null when none of them reported any. */
export function cellUsage(e: Pick<EvalEntry, 'attempts'>, cellKey: string): TokenUsage | null {
  return sumUsage(e.attempts.filter((a) => a.cell === cellKey && counted(a)).map((a) => a.usage))
}
