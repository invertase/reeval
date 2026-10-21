// The `Remarks:` section under the tally: what's wrong with the evals themselves, each with its
// fix. Concerns only and at most `REMARK_CAP` of them; `verbose` adds the rest and the
// suggestions. A remark prints until a run has printed it, so once you've seen it a run on the
// same source prints nothing, except a slow MCP start, which prints in every run it happens. With
// none to print there's no heading.
import { clip } from '../text.ts'
import type { Remark, RunInsights } from '../view/insights.ts'
import type { SuiteResult } from '../view/suite.ts'
import type { Colors } from './colors.ts'

/** The most concerns the section prints without `verbose`. */
export const REMARK_CAP = 3

/** Whether a remark may print in this run: no earlier run printed it, or it's a slow MCP start. */
export const printsIn = (r: Remark, runId: string) =>
  r.firstSeenRun === runId || r.kind === 'slow-mcp-start'

/** The remarks the section prints, in order, and how many concerns the cap left out. */
export function shownRemarks(remarks: Remark[], runId: string, verbose: boolean) {
  const printable = remarks.filter((r) => printsIn(r, runId))
  const concerns = printable.filter((r) => r.severity === 'concern')
  const shown = verbose ? printable : concerns.slice(0, REMARK_CAP)
  return { shown, hidden: verbose ? 0 : concerns.length - shown.length }
}

/** Each remark marked with whether the section prints it in this run (`printed`). */
export function markPrinted(remarks: Remark[], runId: string, verbose: boolean): Remark[] {
  const shown = new Set(shownRemarks(remarks, runId, verbose).shown)
  return remarks.map((r) => ({ ...r, printed: shown.has(r) }))
}

/** `evals/a.eval.ts:12` from `source:evals/a.eval.ts#L12`. */
const location = (at: string) => at.replace(/^source:/, '').replace(/#L(\d+)$/, ':$1')

export function remarkLines(
  c: Colors,
  suite: SuiteResult,
  insights: RunInsights | null,
  verbose: boolean,
): string[] {
  const { shown, hidden } = shownRemarks(insights?.remarks ?? [], suite.runId, verbose)
  if (!shown.length) return []
  const names = new Map(
    suite.files.flatMap((f) =>
      f.evals.map((e) => [e.path, [...e.group, e.template ?? e.name].join(' › ')] as const),
    ),
  )
  return [
    '',
    'Remarks:',
    ...shown.flatMap((r) => [
      `  ${names.get(r.evalId) ?? r.evalId}: ${r.text}`,
      r.fix.edit
        ? `    ${c.dim('fix')}  ${location(r.fix.at)}  ${clip(r.fix.edit, 160)}`
        : `    ${c.dim('at')}   ${location(r.fix.at)}`,
    ]),
    ...(hidden > 0 ? [c.dim(`  +${hidden} more (-v)`)] : []),
  ]
}
