// The `Remarks:` section under the tally: what's wrong with the evals themselves, each with its
// fix. Concerns only and at most `REMARK_CAP` of them; `verbose` adds the rest and the
// suggestions. A remark prints in the run that first raised it, so a second run on the same source
// prints nothing, except a slow MCP start, which prints in every run it happens. With none to
// print there's no heading.
import { clip } from '../text.ts'
import type { Remark, RunInsights } from '../view/insights.ts'
import type { SuiteResult } from '../view/suite.ts'
import type { Colors } from './colors.ts'

/** The most concerns the section prints without `verbose`. */
export const REMARK_CAP = 3

/** Whether a remark prints in this run: the first to raise it, or any run for a slow MCP start. */
export const printsIn = (r: Remark, runId: string) =>
  r.firstSeenRun === runId || r.kind === 'slow-mcp-start'

/** `evals/a.eval.ts:12` from `source:evals/a.eval.ts#L12`. */
const location = (at: string) => at.replace(/^source:/, '').replace(/#L(\d+)$/, ':$1')

export function remarkLines(
  c: Colors,
  suite: SuiteResult,
  insights: RunInsights | null,
  verbose: boolean,
): string[] {
  const printed = (insights?.remarks ?? []).filter((r) => printsIn(r, suite.runId))
  const concerns = printed.filter((r) => r.severity === 'concern')
  const shown = verbose ? printed : concerns.slice(0, REMARK_CAP)
  if (!shown.length) return []
  const names = new Map(
    suite.files.flatMap((f) =>
      f.evals.map((e) => [e.path, [...e.group, e.template ?? e.name].join(' › ')] as const),
    ),
  )
  const hidden = verbose ? 0 : concerns.length - shown.length
  return [
    '',
    'Remarks:',
    ...shown.flatMap((r) => [
      `  ${names.get(r.evalId) ?? r.evalId}: ${r.text}`,
      `    ${c.dim('fix')}  ${location(r.fix.at)}  ${clip(r.fix.edit, 160)}`,
    ]),
    ...(hidden > 0 ? [c.dim(`  +${hidden} more (-v)`)] : []),
  ]
}
