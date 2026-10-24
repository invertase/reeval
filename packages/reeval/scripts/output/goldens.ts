// The output goldens, test/fixtures/output/<name>.txt: each one layout, rendered from the evals it
// names in a corpus run, and each `reeval compare` block, from two corpus runs.
// test/output.test.ts holds the files to these, and `output:preview all` prints them.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RunRecord } from '../../src/history/types.ts'
import { factsHash } from '../../src/insights/hash.ts'
import type { CompareInput } from '../../src/ui/compare-layout.ts'
import { render } from '../../src/ui/layout.ts'
import { type CompareRow, compare, stackChanges } from '../../src/view/compare.ts'
import { runHeader } from '../../src/view/header.ts'
import type { RunInsights } from '../../src/view/insights.ts'
import { readableInsights, readableRecord } from '../../src/view/record.ts'
import { type EvalResult, isStudy, type SuiteResult, suiteResult } from '../../src/view/suite.ts'
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
  /** Rendered with the run's insights.json, as `reeval show` prints it once insights are written. */
  insights?: boolean
  /** The insights as `analysis.maxTokens` leaves them when it runs out before the last `n` evals. */
  budgetSkips?: number
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
  ...(
    [
      ['choose', 'choose.eval.ts'],
      ['finish', 'results.eval.ts › greets in French'],
      ['measure-a-change', 'measure.eval.ts'],
      ['harness', 'harnesses.eval.ts › greets in the house style on each agent'],
      ['both', 'harnesses.eval.ts › learns the house style from the skill'],
      ['family', 'family.eval.ts'],
      ['other', 'results.eval.ts › explains why greet.js fails'],
    ] as const
  ).map(([name, id]) => ({
    name: `insights-${name}`,
    entry: 'with-insights',
    evals: layouts(id),
    insights: true,
  })),
  { name: 'insights-suite', entry: 'with-insights', insights: true },
  { name: 'insights-budget', entry: 'with-insights', insights: true, budgetSkips: 2 },
]

export const OUTPUT_DIR = join(CORPUS_DIR, '..', 'output')

function tallyOf(evals: EvalResult[], errors: number): SuiteResult['tally'] {
  const tally = { errors, pass: 0, notGated: 0, fail: 0, infraError: 0, cancelled: 0, skipped: 0 }
  const units = evals.flatMap((e) => e.cases ?? [e])
  for (const { outcome: o, cells } of units) {
    if (o === 'infra_error') tally.infraError++
    else if (o === 'pass' && isStudy(cells ?? [])) tally.notGated++
    else tally[o]++
  }
  tally.fail += evals.filter((e) => e.pooled?.some((p) => p.outcome === 'fail')).length
  return tally
}

function goldenRun(g: Golden) {
  const entry = corpusEntries().find((e) => e.name === g.entry)
  if (!entry) throw new Error(`No corpus entry ${g.entry}`)
  const run = g.run ? entry.runs.find((r) => r.runId === g.run) : entry.runs.at(-1)
  if (!run) throw new Error(`No run ${g.run ?? '(newest)'} in corpus entry ${g.entry}`)
  return run
}

/**
 * The golden's insights: its run's insights.json, or null, held to the suite's hash. The corpus
 * file keeps the hash of the facts the reeval that recorded it computed, which a later change to
 * `SuiteResult` moves; a golden shows the layout, and the stale file has its own test. A golden
 * cut to some evals leaves out the headline, which speaks for the whole run.
 */
export function goldenInsights(g: Golden, suite: SuiteResult): RunInsights | null {
  if (!g.insights) return null
  const file = join(dirname(goldenRun(g).file), suite.runId, 'insights.json')
  if (!existsSync(file)) throw new Error(`Golden ${g.name}: no ${file}`)
  const stored = readableInsights(JSON.parse(readFileSync(file, 'utf8')), file)
  const insights = g.budgetSkips ? overBudget(stored, g.budgetSkips) : stored
  return { ...insights, factsHash: factsHash(suite), ...(g.evals ? { headline: null } : {}) }
}

const overBudget = (insights: RunInsights, n: number): RunInsights => ({
  ...insights,
  evals: insights.evals.slice(0, -n),
  headline: null,
  budget: { maxTokens: 20_000, skipped: insights.evals.slice(-n).map((e) => e.evalId) },
})

/** The golden's lines: with insights there's an analysis model, so no hint. */
export function goldenRender(g: Golden, o: { color?: boolean; verbose?: boolean } = {}): string[] {
  const suite = goldenSuite(g)
  return render(suite, goldenInsights(g, suite), {
    color: !!o.color,
    verbose: !!o.verbose || !!g.verbose,
    hint: !g.insights,
  })
}

/** The golden's run as a SuiteResult, cut down to its evals, the tally counting only those. */
export function goldenSuite(g: Golden): SuiteResult {
  const run = goldenRun(g)
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
  return {
    ...suite,
    files,
    tally: tallyOf(
      files.flatMap((f) => f.evals),
      suite.errors.length,
    ),
  }
}

export type CompareGolden = {
  name: string
  /** The corpus entry: its oldest run is base and its newest head, or head alone with `noBaseline`. */
  entry: string
  noBaseline?: boolean
  /** The eval ids whose rows to keep; every row when unset. */
  evals?: string[]
  verbose?: boolean
}

const compared = (...names: string[]) => names.map((n) => `evals/${n}`)

/** One per block `reeval compare` prints, from the with-compare entry (scripts/output/compare). */
export const COMPARE_GOLDENS: CompareGolden[] = [
  {
    name: 'compare-regressed',
    entry: 'with-compare',
    evals: compared('greet.eval.ts › greets in the house style'),
  },
  {
    name: 'compare-fixed',
    entry: 'with-compare',
    evals: compared('buttons.eval.ts › adds a double button that builds'),
  },
  {
    name: 'compare-cant-compare',
    entry: 'with-compare',
    evals: compared('billing.eval.ts › bills in minor units with the billing doc'),
  },
  {
    name: 'compare-new-and-removed',
    entry: 'with-compare',
    evals: compared('greet.eval.ts › greets in Spanish', 'greet.eval.ts › greets in German'),
  },
  {
    name: 'compare-same-collapsed',
    entry: 'with-compare',
    evals: compared(
      'buttons.eval.ts › adds a reset button that builds',
      'buttons.eval.ts › adds a clear button that builds',
      'greet.eval.ts › writes greet.js',
      'greet.eval.ts › greets in French',
    ),
  },
  { name: 'compare-no-baseline', entry: 'with-compare', noBaseline: true },
  { name: 'compare', entry: 'with-compare' },
  { name: 'compare-verbose', entry: 'with-compare', verbose: true },
]

const fromFile = (file: string) =>
  readableRecord(JSON.parse(readFileSync(file, 'utf8')) as RunRecord, file)

/** Two recorded runs as `reeval compare` reads them; head alone when `base` is null. */
export function compareInput(base: RunRecord | null, head: RunRecord): CompareInput {
  const headEntry = runHeader(head, true)
  const baseEntry = base ? runHeader(base, true) : null
  const rows = baseEntry
    ? compare(baseEntry, headEntry)
    : headEntry.evals.map(
        (e): CompareRow => ({ id: e.id, base: null, head: e.outcome, status: 'added' }),
      )
  return {
    base: base ? { runId: base.runId, suite: suiteResult(base) } : null,
    head: { runId: head.runId, suite: suiteResult(head) },
    rows,
    changes: baseEntry ? stackChanges(baseEntry, headEntry) : [],
  }
}

/** The golden's compare, its rows cut down to its evals. */
export function goldenCompare(g: CompareGolden): CompareInput {
  const entry = corpusEntries().find((e) => e.name === g.entry)
  const [first, last] = [entry?.runs[0], entry?.runs.at(-1)]
  if (!first || !last || first === last) throw new Error(`Corpus entry ${g.entry} needs two runs`)
  const input = compareInput(g.noBaseline ? null : fromFile(first.file), fromFile(last.file))
  if (!g.evals) return input
  const keep = new Set(g.evals)
  const missing = g.evals.filter((id) => !input.rows.some((r) => r.id === id))
  if (missing.length) throw new Error(`Golden ${g.name}: no row ${missing.join(', ')}`)
  return { ...input, rows: input.rows.filter((r) => keep.has(r.id)) }
}
