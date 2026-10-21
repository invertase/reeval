// The order `analysis.maxTokens` is spent in: the evals most worth explaining first. A failure
// first, then a change that made something worse, then a compare (a question, variants or
// harnesses side by side), then an infrastructure error, then the rest. Within a tier, the order
// the output prints them. Pure: the same facts always give the same order.
import type { EvalResult } from '../view/suite.ts'

const cellsOf = (e: EvalResult) => [...(e.cells ?? []), ...(e.cases ?? []).flatMap((k) => k.cells)]

const madeWorse = (e: EvalResult) =>
  (e.pooled ?? []).some((p) => p.effect === 'worse') ||
  cellsOf(e).some((c) => c.effect === 'worse' || c.checks.some((k) => k.effect === 'worse'))

/** 0 is spent first. */
export function insightTier(e: EvalResult): number {
  if (e.outcome === 'fail') return 0
  if (madeWorse(e)) return 1
  if (e.questions.length || e.across !== 'none') return 2
  if (e.outcome === 'infra_error') return 3
  return 4
}

/** `evals` (in output order) in the order the budget reaches them. */
export const byPriority = (evals: EvalResult[]): EvalResult[] =>
  evals
    .map((e, i) => ({ e, i, tier: insightTier(e) }))
    .sort((a, b) => a.tier - b.tier || a.i - b.i)
    .map((x) => x.e)
