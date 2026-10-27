// A cell's gate as compare and the history read it: its label, its fingerprint part, and the
// outcome its attempts give under it. Browser-safe, so the studio re-scores a run as the CLI does.
import type { FingerprintParts, HistoryCell } from '../history/types.ts'
import type { CellGate, Outcome } from '../types.ts'

/** `all`, `none` or `passRate 0.5`; `{ passRate: 1 }` is `all`, which scores the same. */
export const gateLabel = (gate: CellGate) =>
  typeof gate === 'string' ? gate : gate.passRate === 1 ? 'all' : `passRate ${gate.passRate}`

/** The gate's part of a fingerprint: none on `'all'`, so such a cell keeps its fingerprint. */
export const gatePart = (gate: CellGate): Pick<FingerprintParts, 'gate'> => {
  const label = gateLabel(gate)
  return label === 'all' ? {} : { gate: label }
}

/** Any failure fails; then infra errors; then all-skipped; else pass. */
export function worstOutcome(outcomes: Outcome[]): Outcome {
  if (outcomes.includes('fail')) return 'fail'
  if (outcomes.includes('infra_error')) return 'infra_error'
  if (outcomes.length > 0 && outcomes.every((o) => o === 'skipped')) return 'skipped'
  return outcomes.length ? 'pass' : 'skipped'
}

export const passRateOf = (outcomes: Outcome[]) => {
  const pass = outcomes.filter((o) => o === 'pass').length
  const counted = pass + outcomes.filter((o) => o === 'fail').length
  return counted ? pass / counted : null
}

/**
 * A cell's outcome by its gate. `'all'` matches `{ passRate: 1 }`: every counted attempt must
 * pass, and it is an infra error only when nothing counted. `'none'` takes the worst attempt.
 */
export function cellOutcome(outcomes: Outcome[], gate: CellGate): Outcome {
  if (gate === 'none') return worstOutcome(outcomes)
  const required = gate === 'all' ? 1 : gate.passRate
  const rate = passRateOf(outcomes)
  if (rate === null) return worstOutcome(outcomes)
  return rate >= required ? 'pass' : 'fail'
}

type Tallied = Pick<
  HistoryCell,
  'gate' | 'outcome' | 'pass' | 'fail' | 'infraError' | 'skipped' | 'canceled'
>

/** The cell's attempts, less the fails the run's interrupt canceled, which the agent didn't fail. */
const outcomesOf = (c: Tallied): Outcome[] => [
  ...Array<Outcome>(c.pass).fill('pass'),
  ...Array<Outcome>(c.fail - (c.canceled ?? 0)).fill('fail'),
  ...Array<Outcome>(c.infraError).fill('infra_error'),
  ...Array<Outcome>(c.skipped).fill('skipped'),
]

/**
 * A cell's recorded attempts scored under another gate. A cell its own gate passes but that
 * failed anyway fell short of its `minLift`, which no gate changes, so it still fails.
 */
export function rescore(c: Tallied, gate: CellGate): Outcome {
  const outcomes = outcomesOf(c)
  const liftFailed = c.outcome === 'fail' && cellOutcome(outcomes, c.gate) === 'pass'
  return liftFailed ? 'fail' : cellOutcome(outcomes, gate)
}
