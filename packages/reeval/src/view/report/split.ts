import type { AttemptIndexRow, EvalSection, RunReport } from './types.ts'

/** The newest `reportVersion` this reeval writes and reads. */
export const REPORT_VERSION = 1 satisfies RunReport['reportVersion']

/** One eval as the report's index lists it: its section's heading and headline, not its blocks. */
export type EvalSummary = Pick<
  EvalSection,
  'id' | 'anchor' | 'name' | 'file' | 'shapes' | 'design' | 'headline'
> & {
  /** How many rows of the attempt index are this eval's: its `EvalDetail.attempts`. */
  attempts: number
}

/**
 * A `RunReport` without its per-eval detail: every top-level block, and each eval's summary in
 * the report's order. A page draws the run from it, then fetches each eval's `EvalDetail` on demand.
 */
export type RunReportIndex = Omit<RunReport, 'evals' | 'attempts'> & { evals: EvalSummary[] }

/** One eval's whole section of a `RunReport`, with the attempt index's rows for that eval. */
export type EvalDetail = {
  reportVersion: RunReport['reportVersion']
  runId: string
  eval: EvalSection
  /** In the attempt index's order. */
  attempts: AttemptIndexRow[]
}

export type SplitRunReport = { index: RunReportIndex; details: EvalDetail[] }

/** The attempt index's order: by the number in each row's display id, `A1..AN`. */
const inIdOrder = (a: AttemptIndexRow, b: AttemptIndexRow) =>
  Number(a.id.slice(1)) - Number(b.id.slice(1))

/**
 * `report` as its index and one detail per eval, which `joinRunReport` puts back together exactly.
 * Each attempt index row names its eval (`AttemptIndexRow.evalId`, the section's `id`) and the
 * rows are in their display ids' order, as `buildRunReport` writes them; a report that isn't
 * throws.
 */
export function splitRunReport(report: RunReport): SplitRunReport {
  const { evals, attempts, ...top } = report
  const rows = new Map<string, AttemptIndexRow[]>(evals.map((e) => [e.id, []]))
  attempts.forEach((row, i) => {
    const of = rows.get(row.evalId)
    if (!of) throw new Error(`Attempt ${row.key} names eval ${row.evalId}, which the report lacks`)
    const prev = attempts[i - 1]
    if (prev && inIdOrder(prev, row) >= 0)
      throw new Error(`Attempt ${row.id} is out of the index's order`)
    of.push(row)
  })
  const details = evals.map(
    (e): EvalDetail => ({
      reportVersion: report.reportVersion,
      runId: report.runId,
      eval: e,
      attempts: rows.get(e.id) ?? [],
    }),
  )
  const index: RunReportIndex = {
    ...top,
    evals: details.map(({ eval: e, attempts }) => ({
      id: e.id,
      anchor: e.anchor,
      name: e.name,
      file: e.file,
      shapes: e.shapes,
      design: e.design,
      headline: e.headline,
      attempts: attempts.length,
    })),
  }
  return { index, details }
}

/** The `RunReport` that `splitRunReport` split into `index` and `details`, keys in its order. */
export function joinRunReport(index: RunReportIndex, details: readonly EvalDetail[]): RunReport {
  const byId = new Map(details.map((d) => [d.eval.id, d]))
  const detailOf = (id: string) => {
    const d = byId.get(id)
    if (!d) throw new Error(`No detail for eval ${id}`)
    return d
  }
  const { evals, actions, provenance, ...head } = index
  return {
    ...head,
    evals: evals.map((e) => detailOf(e.id).eval),
    actions,
    provenance,
    attempts: evals.flatMap((e) => detailOf(e.id).attempts).sort(inIdOrder),
  }
}
