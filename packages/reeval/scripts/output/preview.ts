// `pnpm --filter reeval output:preview [run.json | corpus-name | all] [-v]`: prints the result
// blocks `reeval run` ends with for a recorded run, a corpus entry's runs, or every corpus run and
// golden, straight from src/ so a layout change shows without a build.
import { readFileSync } from 'node:fs'
import type { RunRecord } from '../../src/history/types.ts'
import { render } from '../../src/ui/layout.ts'
import { readableRecord } from '../../src/view/record.ts'
import { suiteResult } from '../../src/view/suite.ts'
import { corpusEntries } from '../schema/corpus.ts'
import { GOLDENS, goldenSuite } from './goldens.ts'

const args = process.argv.slice(2)
const verbose = args.includes('-v') || args.includes('--verbose')
const color = args.includes('--color')
const target = args.find((a) => !a.startsWith('-')) ?? 'all'
const opts = { color, verbose }

const print = (title: string, lines: string[]) => {
  process.stdout.write(`── ${title}\n\n${lines.join('\n')}\n\n`)
}
const fromFile = (file: string) =>
  readableRecord(JSON.parse(readFileSync(file, 'utf8')) as RunRecord, file)

const entries = corpusEntries()
if (target.endsWith('.json')) {
  print(target, render(suiteResult(fromFile(target)), null, opts))
} else {
  const named = entries.filter((e) => target === 'all' || e.name === target)
  if (!named.length && target !== 'all') {
    process.stderr.write(
      `No corpus entry ${target}. Entries: ${entries.map((e) => e.name).join(', ')}\n`,
    )
    process.exit(2)
  }
  for (const entry of named) {
    for (const run of entry.runs) {
      print(`${entry.name} ${run.runId}`, render(suiteResult(fromFile(run.file)), null, opts))
    }
  }
  if (target === 'all') {
    for (const g of GOLDENS) {
      const lines = render(goldenSuite(g), null, { color, verbose: verbose || !!g.verbose })
      print(`golden ${g.name}`, lines)
    }
  }
}
