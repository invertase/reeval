// `reeval/renderer/ascii`: a `RunReport` as plain terminal text. Its signature is the contract;
// the renderer isn't written yet, so it throws.
import type { RunReport } from '../view/report/types.ts'

export type RunReportTextOptions = {
  /** Columns to wrap and size tables to. */
  width?: number
}

export function runReportText(report: RunReport, options: RunReportTextOptions = {}): string {
  void report
  void options
  throw new Error('runReportText (reeval/renderer/ascii) is not implemented yet')
}
