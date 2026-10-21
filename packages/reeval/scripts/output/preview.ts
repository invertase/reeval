// `pnpm --filter reeval output:preview [run.json [head.json] | corpus-name | golden | all] [-v]
// [--insights <file>]`: prints the result blocks `reeval run` ends with for a recorded run (or
// `reeval compare`'s for two), a corpus entry's runs, one golden, or every corpus run and golden,
// straight from src/ so a layout change shows without a build. `--insights` renders a run with an
// insights.json, written by hand or by `reeval analyze --insights`; one written for other facts is
// rendered anyway, with a note.
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { RunRecord } from '../../src/history/types.ts'
import { factsHash } from '../../src/insights/hash.ts'
import { renderCompare } from '../../src/ui/compare-layout.ts'
import { render } from '../../src/ui/layout.ts'
import type { RunInsights } from '../../src/view/insights.ts'
import { readableInsights, readableRecord } from '../../src/view/record.ts'
import { type SuiteResult, suiteResult } from '../../src/view/suite.ts'
import { corpusEntries } from '../schema/corpus.ts'
import {
  COMPARE_GOLDENS,
  compareInput,
  GOLDENS,
  goldenCompare,
  goldenRender,
  goldenSuite,
} from './goldens.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    verbose: { type: 'boolean', short: 'v' },
    color: { type: 'boolean' },
    insights: { type: 'string' },
  },
})
const verbose = !!values.verbose
const color = !!values.color
const target = positionals[0] ?? 'all'
const opts = { color, verbose, hint: !values.insights }

/** The --insights file, held to these facts so a hand-written file renders. */
function insightsFor(suite: SuiteResult): RunInsights | null {
  if (!values.insights) return null
  const insights = readableInsights(
    JSON.parse(readFileSync(values.insights, 'utf8')),
    values.insights,
  )
  const hash = factsHash(suite)
  if (insights.factsHash === hash) return insights
  process.stderr.write(
    `note: ${values.insights} was written for other facts (${insights.factsHash}); rendering it against ${hash}\n`,
  )
  return { ...insights, factsHash: hash }
}

const print = (title: string, lines: string[]) => {
  process.stdout.write(`── ${title}\n\n${lines.join('\n')}\n\n`)
}
const fromFile = (file: string) =>
  readableRecord(JSON.parse(readFileSync(file, 'utf8')) as RunRecord, file)

const entries = corpusEntries()
const head = positionals[1]
if (target.endsWith('.json') && head?.endsWith('.json')) {
  const input = compareInput(fromFile(target), fromFile(head))
  print(`compare ${target} ${head}`, renderCompare(input, { color, verbose }))
} else if (target.endsWith('.json')) {
  const suite = suiteResult(fromFile(target))
  print(target, render(suite, insightsFor(suite), opts))
} else {
  const named = entries.filter((e) => target === 'all' || e.name === target)
  const goldens = GOLDENS.filter((g) => target === 'all' || g.name === target)
  const compares = COMPARE_GOLDENS.filter((g) => target === 'all' || g.name === target)
  if (!named.length && !goldens.length && !compares.length) {
    const all = [...GOLDENS, ...COMPARE_GOLDENS].map((g) => g.name)
    process.stderr.write(
      `No corpus entry or golden ${target}. Entries: ${entries.map((e) => e.name).join(', ')}. Goldens: ${all.join(', ')}\n`,
    )
    process.exit(2)
  }
  for (const entry of named) {
    for (const run of entry.runs) {
      const suite = suiteResult(fromFile(run.file))
      print(`${entry.name} ${run.runId}`, render(suite, insightsFor(suite), opts))
    }
  }
  for (const g of goldens) {
    if (values.insights) {
      const suite = goldenSuite(g)
      print(`golden ${g.name}`, render(suite, insightsFor(suite), opts))
    } else print(`golden ${g.name}`, goldenRender(g, { color, verbose }))
  }
  for (const g of compares) {
    print(
      `golden ${g.name}`,
      renderCompare(goldenCompare(g), { color, verbose: verbose || !!g.verbose }),
    )
  }
}
