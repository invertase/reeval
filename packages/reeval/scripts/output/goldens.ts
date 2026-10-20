// The output goldens, test/fixtures/output/<name>.txt: each one layout, rendered from the evals it
// names in a corpus run. test/output.test.ts holds the files to these, and `output:preview all`
// prints them.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunRecord } from '../../src/history/types.ts'
import { readableRecord } from '../../src/view/record.ts'
import { type EvalResult, type SuiteResult, suiteResult } from '../../src/view/suite.ts'
import { CORPUS_DIR, corpusEntries } from '../schema/corpus.ts'

export type Golden = {
  name: string
  /** The corpus entry, and its run (the newest when unset). */
  entry: string
  run?: string
  /** The eval or family ids, or eval files, to keep; every eval when unset. */
  evals?: string[]
  /** Rendered as `-v` prints it. */
  verbose?: boolean
}

const layouts = (...ids: string[]) => ids.map((id) => `evals/${id}`)

/** One per layout, from the with-layouts entry (scripts/output/project) and real harness runs. */
export const GOLDENS: Golden[] = [
  { name: 'results', entry: 'with-layouts', evals: layouts('results.eval.ts') },
  { name: 'results-real', entry: 'real-contract' },
  { name: 'measure-a-change', entry: 'with-layouts', evals: layouts('measure.eval.ts') },
  {
    name: 'measure-a-change-verbose',
    entry: 'with-layouts',
    evals: layouts('measure.eval.ts'),
    verbose: true,
  },
  {
    name: 'compare-harnesses',
    entry: 'with-layouts',
    evals: layouts('harnesses.eval.ts › greets in the house style on each agent'),
  },
  { name: 'compare-harnesses-real', entry: 'real-harnesses' },
  {
    name: 'both',
    entry: 'with-layouts',
    evals: layouts('harnesses.eval.ts › learns the house style from the skill'),
  },
  {
    name: 'family',
    entry: 'with-layouts',
    evals: layouts('family.eval.ts › adds a $name button that builds'),
  },
  {
    name: 'family-with-change',
    entry: 'with-layouts',
    evals: layouts('family.eval.ts › greets %s in the house style'),
  },
  {
    name: 'family-with-change-verbose',
    entry: 'with-layouts',
    evals: layouts('family.eval.ts › greets %s in the house style'),
    verbose: true,
  },
  { name: 'suite', entry: 'with-layouts' },
]

export const OUTPUT_DIR = join(CORPUS_DIR, '..', 'output')

function tallyOf(evals: EvalResult[]): SuiteResult['tally'] {
  const tally = { pass: 0, fail: 0, infraError: 0, skipped: 0 }
  for (const o of evals.flatMap((e) => (e.cases ? e.cases.map((k) => k.outcome) : [e.outcome]))) {
    if (o === 'infra_error') tally.infraError++
    else tally[o]++
  }
  tally.fail += evals.filter((e) => e.pooled?.some((p) => p.outcome === 'fail')).length
  return tally
}

/** The golden's run as a SuiteResult, cut down to its evals, the tally counting only those. */
export function goldenSuite(g: Golden): SuiteResult {
  const entry = corpusEntries().find((e) => e.name === g.entry)
  if (!entry) throw new Error(`No corpus entry ${g.entry}`)
  const run = g.run ? entry.runs.find((r) => r.runId === g.run) : entry.runs.at(-1)
  if (!run) throw new Error(`No run ${g.run ?? '(newest)'} in corpus entry ${g.entry}`)
  const suite = suiteResult(
    readableRecord(JSON.parse(readFileSync(run.file, 'utf8')) as RunRecord, run.file),
  )
  if (!g.evals) return suite
  const keep = new Set(g.evals)
  const files = suite.files
    .map((f) => ({ ...f, evals: f.evals.filter((e) => keep.has(e.id) || keep.has(f.path)) }))
    .filter((f) => f.evals.length)
  const missing = g.evals.filter(
    (id) => !files.some((f) => f.path === id || f.evals.some((e) => e.id === id)),
  )
  if (missing.length) throw new Error(`Golden ${g.name}: no eval ${missing.join(', ')}`)
  return { ...suite, files, tally: tallyOf(files.flatMap((f) => f.evals)) }
}
