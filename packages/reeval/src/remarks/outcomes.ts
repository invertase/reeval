// Whether a project acts on each remark kind: over its runs' remarks, how many of a kind printed
// and how many of those a later run found acted on (`actedOn`). A kind acted on rarely enough, over
// enough printed, is demoted, so remarks nobody acts on stop crowding the ones they do. Pure: the
// same function feeds `reeval run`'s demotion and the history's `remark_outcomes` view.
import { REMARK_KINDS, type Remark } from '../view/insights.ts'

/** Printed remarks of a kind before its rate can demote it. */
export const OUTCOME_MIN_RAISED = 10
/** Acted on in under this share of a kind's printed remarks: demoted to a suggestion. */
export const DEMOTE_RATE = 0.2
/** Under this share: hidden, never printed. */
export const HIDE_RATE = 0.05

export type OutcomeStatus = 'kept' | 'demoted' | 'hidden'

export type RemarkOutcome = {
  kind: Remark['kind']
  origin: Remark['origin']
  /** The kind's own severity, before any demotion. */
  severity: Remark['severity']
  /** Distinct remarks of the kind some run printed. */
  raised: number
  /** Of those, the ones a later run found acted on. */
  acted_on: number
  /** `acted_on / raised`, rounded to 3 places. */
  rate: number
  status: OutcomeStatus
  min_raised: number
}

/** A run's remarks, as its insights.json lists them. */
export type RunRemarks = { runId: string; remarks: Remark[] }

/** Whether a run's output printed the remark: `printed`, or, without it, the run that raised it first. */
export const printedIn = (r: Remark, runId: string) =>
  r.printed === true || (r.printed === undefined && r.firstSeenRun === runId && !r.actedOn)

/**
 * Each kind's outcome over the runs. `slow-mcp-start` is about the environment, not the eval's
 * source, so no edit acts on it and it's left out.
 */
export function remarkOutcomes(runs: RunRemarks[]): RemarkOutcome[] {
  const raised = new Map<string, Remark['kind']>()
  const acted = new Set<string>()
  for (const run of runs) {
    for (const r of run.remarks) {
      if (r.kind === 'slow-mcp-start' || !REMARK_KINDS[r.kind]) continue
      if (r.actedOn) acted.add(r.id)
      else if (printedIn(r, run.runId)) raised.set(r.id, r.kind)
    }
  }
  const out: RemarkOutcome[] = []
  for (const kind of Object.keys(REMARK_KINDS) as Array<Remark['kind']>) {
    if (kind === 'slow-mcp-start') continue
    const ids = [...raised].filter(([, k]) => k === kind).map(([id]) => id)
    if (!ids.length) continue
    const done = ids.filter((id) => acted.has(id)).length
    const rate = done / ids.length
    out.push({
      kind,
      origin: REMARK_KINDS[kind].origin,
      severity: REMARK_KINDS[kind].severity,
      raised: ids.length,
      acted_on: done,
      rate: Math.round(rate * 1000) / 1000,
      status:
        ids.length < OUTCOME_MIN_RAISED
          ? 'kept'
          : rate < HIDE_RATE
            ? 'hidden'
            : rate < DEMOTE_RATE
              ? 'demoted'
              : 'kept',
      min_raised: OUTCOME_MIN_RAISED,
    })
  }
  return out
}
