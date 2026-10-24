// Compare questions and the analyst on a real model, nightly (real.yml's `real agents (Cursor)` job,
// never on PRs): test/real-agents' `questions` profile, under reeval.analysis.config.ts, runs 4 real
// attempts on Cursor and pi; google/gemini-3.8-flash answers its question and writes the run's
// insights. Checks structure only, never the model's wording,
// and never retries. Skipped unless REEVAL_TEST_REAL=1.
import assert from 'node:assert/strict'
import { cpSync, readFileSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ShapeSchema } from '../scripts/schema/generate.ts'
import { fits, validate } from '../scripts/schema/validate.ts'
import { ratesOf } from '../src/compare/pairs.ts'
import type { RunRecord } from '../src/history/types.ts'
import type { PairVote } from '../src/types.ts'
import { answerRows, recordPath } from '../src/view/index.ts'
import type { RunInsights } from '../src/view/insights.ts'
import { pkgRoot, readRun, runCli, tempDir } from './helpers.ts'
import { harnesses, reserveAttempts } from './support/harnesses.ts'

const example = join(pkgRoot, 'test/real-agents')
const schema = (name: string) =>
  JSON.parse(readFileSync(join(pkgRoot, 'schema', `${name}.schema.json`), 'utf8')) as ShapeSchema

const skip =
  process.env.REEVAL_TEST_REAL === '1' ? false : 'set REEVAL_TEST_REAL=1 to run real agents'

/** A pair's identity, the same for its two votes. */
const pairKey = (v: PairVote) => [v.cut, v.harness ?? v.arm, v.run, v.a, v.b].join('\0')

test('test/real-agents --profile questions: every pair is voted in both orders; insights are written', {
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

  // Insights: the run's one eval classified and explained by analysis.model at the end of the run.
  const insights = JSON.parse(
    readFileSync(join(dir, '.reeval/runs', run.runId, 'insights.json'), 'utf8'),
  ) as RunInsights
  assert.deepEqual(validate(schema('insights'), insights), [], 'insights.json fits its schema')
  assert.equal(insights.model, 'google/gemini-3.8-flash')
  assert.equal(insights.evals.length, 1, 'one insight for the one eval')
  const [insight] = insights.evals as [RunInsights['evals'][number]]
  t.diagnostic(`classified ${insight.intent.job}: ${insight.intent.question}`)
  assert.ok(insights.usage.inputTokens > 0, 'insights record their tokens')
  assert.equal(insights.budget?.skipped.length ?? 0, 0, 'nothing skipped for the budget')
  assert.match(
    r.stdout + r.stderr,
    /insights: 1 eval with /,
    'reeval run says insights are running',
  )
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
