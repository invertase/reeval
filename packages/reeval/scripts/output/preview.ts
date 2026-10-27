// `pnpm --filter reeval output:preview [run.json [head.json] | corpus-name | golden | all] [-v]`:
// prints the result blocks `reeval run` ends with for a recorded run (or `reeval compare`'s for
// two), a corpus entry's runs, one golden, or every corpus run and golden, straight from src/ so a
// layout change shows without a build.
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { RunRecord } from '../../src/history/types.ts'
import { renderCompare } from '../../src/ui/compare-layout.ts'
import { render } from '../../src/ui/layout.ts'
import { readableRecord } from '../../src/view/record.ts'
import { suiteResult } from '../../src/view/suite.ts'
import { corpusEntries } from '../schema/corpus.ts'
import { COMPARE_GOLDENS, compareInput, GOLDENS, goldenCompare, goldenRender } from './goldens.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    verbose: { type: 'boolean', short: 'v' },
    color: { type: 'boolean' },
  },
})
const verbose = !!values.verbose
const color = !!values.color
const target = positionals[0] ?? 'all'
const opts = { color, verbose }

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
  print(target, render(suite, null, opts))
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
      print(`${entry.name} ${run.runId}`, render(suite, null, opts))
    }
  }
  for (const g of goldens) {
    print(`golden ${g.name}`, goldenRender(g, { color, verbose }))
  }
  for (const g of compares) {
    print(
      `golden ${g.name}`,
      renderCompare(goldenCompare(g), { color, verbose: verbose || !!g.verbose }),
    )
  }
}
