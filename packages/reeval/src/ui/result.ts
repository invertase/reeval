// What `reeval run` prints when it ends, in every mode: errors outside any eval, the result
// blocks, the run's time and where its results are, then the tally and the hint.
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
    ...(record.status === 'budget'
      ? [c.yellow('Budget reached: attempts that hadn’t started were skipped')]
      : []),
    ...(record.status === 'interrupted'
      ? [c.yellow('Interrupted: attempts that hadn’t finished were cancelled')]
      : []),
    c.dim(
      [formatDuration(record.durationMs), tokens, `results ${e.summaryPath}`]
        .filter(Boolean)
        .join(' · '),
    ),
  ]
  return [
    ...e.unhandledErrors.flatMap((error) => [c.red(`error: ${error}`), '']),
    ...render(suiteResult(record), null, { color: c.enabled, verbose, notes }),
  ]
}
