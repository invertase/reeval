// What `reeval run` prints when it ends, in every mode: the result blocks (errors outside any eval
// first), the run's time and where its results are, then the tally and the remarks.
import { formatDuration } from '../text.ts'
import { formatUsage } from '../view/model.ts'
import { suiteResult } from '../view/suite.ts'
import type { Colors } from './colors.ts'
import type { ReevalEvent } from './events.ts'
import { render } from './layout.ts'

type RunEnd = Extract<ReevalEvent, { type: 'run-end' }>

export function resultLines(c: Colors, e: RunEnd, verbose: boolean): string[] {
  const { record } = e
  const tokens = formatUsage(record.cost.usage)
  const notes = [
    ...(e.notRun
      ? [
          c.yellow(
            `Incomplete: ${e.notRun === 1 ? '1 attempt' : `${e.notRun} attempts`} this resume’s filters left out ${e.notRun === 1 ? 'is' : 'are'} not run; reeval run --resume ${record.runId} runs ${e.notRun === 1 ? 'it' : 'them'}`,
          ),
        ]
      : []),
    ...(record.status === 'budget' && !e.notRun
      ? [c.yellow('Budget reached: attempts that hadn’t started were skipped')]
      : []),
    ...(record.status === 'interrupted' && !e.notRun
      ? [c.yellow('Interrupted: attempts that hadn’t finished were canceled')]
      : []),
    c.dim(
      [formatDuration(record.durationMs), tokens, `results ${e.summaryPath}`]
        .filter(Boolean)
        .join(' · '),
    ),
  ]
  return render(suiteResult(record), e.remarks ?? null, {
    color: c.enabled,
    verbose,
    notes,
  })
}
