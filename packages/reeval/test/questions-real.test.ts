// Compare questions and the analyst on a real model, nightly (real.yml's `real agents (Cursor)` job,
// never on PRs): examples/hello's `questions` profile, under reeval.analysis.config.ts (analysis.agent
// on), runs 4 real attempts on Cursor and pi; google/gemini-3.8-flash answers its question, writes
// a note on each harness and summarises the run. Checks structure only, never the model's wording,
// and never retries. Skipped unless REEVAL_TEST_REAL=1.
import assert from 'node:assert/strict'
import { cpSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ShapeSchema } from '../scripts/schema/generate.ts'
import { fits, validate } from '../scripts/schema/validate.ts'
import { ratesOf } from '../src/compare/pairs.ts'
import type { RunRecord } from '../src/history/types.ts'
import type { PairVote } from '../src/types.ts'
import type { AnalysisDoc, AnalysisNote } from '../src/view/analysis.ts'
import { answerRows, recordPath } from '../src/view/index.ts'
import { pkgRoot, readRun, runCli, tempDir } from './helpers.ts'
import { harnesses, reserveAttempts } from './support/harnesses.ts'

const example = join(pkgRoot, '../../examples/hello')
const schema = (name: string) =>
  JSON.parse(readFileSync(join(pkgRoot, 'schema', `${name}.schema.json`), 'utf8')) as ShapeSchema

const skip =
  process.env.REEVAL_TEST_REAL === '1' ? false : 'set REEVAL_TEST_REAL=1 to run real agents'

/** A pair's identity, the same for its two votes. */
const pairKey = (v: PairVote) => [v.cut, v.harness ?? v.arm, v.run, v.a, v.b].join('\0')

test('examples/hello --profile questions: every pair is voted in both orders; notes and a summary are written', {
  skip,
  timeout: 1_800_000,
}, async (t) => {
  for (const id of ['cursor', 'pi'] as const) {
    const row = harnesses.find((r) => r.id === id)
    assert.ok(row)
    reserveAttempts(row, 2, 'questions')
  }
  const dir = tempDir('questions-real')
  cpSync(example, dir, {
    recursive: true,
    filter: (src) => !/[/\\](node_modules|\.reeval)([/\\]|$)/.test(src.slice(example.length)),
  })
  await mkdir(join(dir, 'node_modules'))
  await symlink(pkgRoot, join(dir, 'node_modules/reeval'), 'dir')
  const env = {
    CURSOR_API_KEY: process.env.CURSOR_API_KEY,
    GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  }
  const r = await runCli(
    dir,
    ['run', '--config', 'reeval.analysis.config.ts', '--profile', 'questions'],
    { env, timeoutMs: 1_500_000 },
  )
  // The checks decide the exit code; a question never makes it 2 or 3.
  assert.ok(r.code === 0 || r.code === 1, `reeval run exited ${r.code}\n${r.stdout}\n${r.stderr}`)
  const { run } = readRun(dir)
  assert.equal(run.summary.attempts, 4, 'the profile runs 4 attempts')
  assert.deepEqual(validate(schema('run-record'), run), [], 'the record fits its schema')

  const [e] = run.evals
  assert.ok(e)
  assert.equal(e.answers?.length, 1, 'one answer for the one question')
  const [answer] = e.answers ?? []
  assert.ok(answer)
  t.diagnostic(`${e.attempts.map((a) => `${a.id} ${a.outcome}`).join(', ')}`)
  t.diagnostic(answer.rates.map((r) => `${r.name} won ${r.wins} of ${r.n}`).join(', '))
  const doc = schema('run-record')
  assert.ok(fits(doc, { $ref: '#/$defs/CompareAnswer' }, answer), 'the answer fits CompareAnswer')
  assert.equal(answer.error, undefined, `the model call failed: ${answer.error}`)
  assert.equal(answer.model, 'google/gemini-3.8-flash')
  const outcomes = e.attempts.map((a) => `${a.id} ${a.outcome}`).join(', ')
  assert.ok(answer.votes.length > 0, `no pair to judge: ${outcomes}`)

  const pairs = new Map<string, PairVote[]>()
  for (const v of answer.votes) {
    assert.ok([v.a, v.b, 'tie'].includes(v.winner), `${v.winner} is a side of its pair`)
    pairs.set(pairKey(v), [...(pairs.get(pairKey(v)) ?? []), v])
  }
  for (const votes of pairs.values()) {
    assert.deepEqual(
      votes.map((v) => v.swapped).sort(),
      [false, true],
      'each pair has one vote in each order',
    )
  }
  assert.deepEqual(answer.rates, ratesOf(answer.votes), 'rates are wins over decided votes')

  // Position bias: in a pair both of whose votes decided, the first slot winning twice means a
  // different winner each time. It fails only when every such pair went the same slot's way.
  const decided = [...pairs.values()].filter((votes) => votes.every((v) => v.winner !== 'tie'))
  const slot = (votes: PairVote[]) => {
    const plain = votes.find((v) => !v.swapped) as PairVote
    const swapped = votes.find((v) => v.swapped) as PairVote
    if (plain.winner === plain.a && swapped.winner === swapped.b) return 'first'
    if (plain.winner === plain.b && swapped.winner === swapped.a) return 'second'
    return 'consistent'
  }
  const slots = decided.map(slot)
  if (slots.length) {
    assert.ok(
      !slots.every((s) => s === 'first') && !slots.every((s) => s === 'second'),
      `every decided pair followed the ${slots[0]} slot: ${JSON.stringify(answer.votes)}`,
    )
  }

  // analysis.agent: one note on each eval and harness, then one run-scoped summary in the cache.
  const cache = join(dir, '.reeval/analysis')
  const notesDir = join(cache, run.runId, 'notes')
  const notes = readdirSync(notesDir).map(
    (n) => JSON.parse(readFileSync(join(notesDir, n), 'utf8')) as AnalysisNote,
  )
  assert.deepEqual(
    notes.map((n) => n.harness).sort(),
    [...new Set(e.cells.map((c) => c.harness))].sort(),
    'one note per harness of the one eval',
  )
  for (const note of notes) {
    t.diagnostic(`note ${note.harness}: ${note.text.length} characters`)
    assert.equal(note.error, undefined, `${note.harness}'s note failed: ${note.error}`)
    assert.deepEqual(validate(schema('analysis-note'), note), [], `${note.harness}'s note`)
    assert.ok(note.text.length > 0, `${note.harness}'s note has text`)
    assert.deepEqual(
      [...note.attempts].sort(),
      e.attempts
        .filter((a) => e.cells.find((c) => c.key === a.cell)?.harness === note.harness)
        .map((a) => a.id)
        .sort(),
      `${note.harness}'s note covers its attempts`,
    )
  }
  const docs = readdirSync(cache)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(cache, n), 'utf8')) as AnalysisDoc)
  assert.equal(docs.length, 1, 'one summary')
  const [summary] = docs as [AnalysisDoc]
  assert.equal(summary.error, undefined, `the summary failed: ${summary.error}`)
  assert.deepEqual(validate(schema('analysis'), summary), [], 'the summary fits its schema')
  assert.deepEqual(
    [summary.scope.kind, summary.anchor, summary.model],
    ['run', run.runId, 'google/gemini-3.8-flash'],
  )
  t.diagnostic(
    `summary: ${summary.validation.citations} citations, ${summary.validation.invalid.length} invalid, ${summary.validation.dropped} dropped`,
  )
  const claims = [
    ...summary.analysis.whatHappened,
    ...summary.analysis.results,
    ...summary.analysis.why,
    ...summary.analysis.anomalies,
    ...summary.analysis.actions,
  ]
  assert.ok(summary.analysis.tldr.length > 0, 'the summary has a TL;DR')
  assert.ok(claims.length > 0, 'a claim survived validation')
  const known = new Set(Object.keys(summary.attempts))
  for (const c of claims) {
    assert.ok(c.cites.length > 0, 'every kept claim cites something')
    for (const id of c.cites.filter((x) => /^r\d+\//.test(x))) {
      assert.ok(known.has(id.replace(/:exec\d+$/, '')), `${id} is an attempt of the run`)
    }
  }
  const analyze = await runCli(
    dir,
    ['analyze', run.runId, '--config', 'reeval.analysis.config.ts', '--json'],
    { env },
  )
  assert.equal(analyze.code, 0, analyze.stderr)
  assert.match(analyze.stderr, /^cached analysis from /, 'reeval analyze is served from the cache')
  assert.deepEqual(JSON.parse(analyze.stdout), summary)
  // The studio's run page reads the same answer from a static build (the run isn't recorded, so
  // --scratch): one row, its rates per cut.
  const out = join(dir, 'site')
  const built = await runCli(dir, [
    'studio',
    'build',
    '--out',
    out,
    '--scratch',
    '--config',
    'reeval.analysis.config.ts',
  ])
  assert.equal(built.code, 0, built.stderr)
  const page = JSON.parse(readFileSync(join(out, recordPath(run.runId)), 'utf8')) as RunRecord
  const [row, ...more] = answerRows(page.evals[0] as RunRecord['evals'][number])
  assert.ok(row)
  assert.equal(more.length, 0)
  assert.equal(row.votes, answer.votes.length)
  assert.equal(row.error, null)
  assert.deepEqual(
    [
      ...row.within.map((r) => ['within', r.name, r.wins, r.n]),
      ...row.across.map((r) => ['across', r.name, r.wins, r.n]),
    ],
    answer.rates.map((r) => [r.cut, r.name, r.wins, r.n]),
  )
})
