// What a result means (plan-of-attack wave 2): gate policies, lift with its interval, and what a
// fingerprint covers. Pure functions here; the CLI behaviour is in options.test.ts and
// history.test.ts.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { type PairAttempt, pairsOf, ratesOf, voteOf } from '../src/compare/pairs.ts'
import { answerQuestion, blindPair, stagedAttempt } from '../src/compare/questions.ts'
import type { EngineEval } from '../src/engine/node.ts'
import { cellOutcome, fingerprintOf, judgementKey } from '../src/history/assemble.ts'
import { runnerInfo } from '../src/history/provenance.ts'
import { traceSources } from '../src/history/sources.ts'
import type { FingerprintParts } from '../src/history/types.ts'
import { patchForJudge } from '../src/judge/patch.ts'
import { checkGate } from '../src/options.ts'
import { liftInterval, wilson } from '../src/stats.ts'
import type { BlindPair, EvalRecord, FakeAnalysisModel, Outcome } from '../src/types.ts'
import { tempDir } from './helpers.ts'
import {
  E2E_ARMS,
  e2ePairSides,
  newlineVote,
  REAL_HARNESSES,
  realAttempts,
} from './support/real-runs.ts'

const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 5e-4, `${what}: ${actual} is not ${expected}`)

describe('Wilson interval for one pass rate', () => {
  // Reference values: Wilson score interval, 95%, as in Newcombe (1998) table I.
  const cases: Array<[number, number, number, number]> = [
    [0, 10, 0, 0.2775],
    [10, 10, 0.7225, 1],
    [5, 10, 0.2366, 0.7634],
    [8, 10, 0.4902, 0.9433],
    [1, 29, 0.0061, 0.1713],
  ]
  for (const [pass, n, low, high] of cases) {
    test(`${pass}/${n} is [${low}, ${high}]`, () => {
      const i = wilson(pass, n)
      near(i.low, low, 'low')
      near(i.high, high, 'high')
    })
  }

  test('no attempts says nothing: [0, 1]', () => {
    assert.deepEqual(wilson(0, 0), { low: 0, high: 1 })
  })
})

describe("Newcombe's interval for lift, from two Wilson intervals", () => {
  test("Newcombe's worked example: 56/70 vs 48/80 is 0.2 in [0.0524, 0.3339]", () => {
    const d = liftInterval({ pass: 56, n: 70 }, { pass: 48, n: 80 })
    near(d.points, 0.2, 'points')
    near(d.low, 0.0524, 'low')
    near(d.high, 0.3339, 'high')
  })

  test('n/n against 0/n, both ways: the interval mirrors, and stays inside [-1, 1]', () => {
    const up = liftInterval({ pass: 5, n: 5 }, { pass: 0, n: 5 })
    const down = liftInterval({ pass: 0, n: 5 }, { pass: 5, n: 5 })
    assert.equal(up.points, 1)
    assert.equal(up.high, 1)
    near(up.low, 1 - Math.SQRT2 * (1 - wilson(5, 5).low), 'low')
    assert.equal(down.points, -1)
    near(down.low, -up.high, 'mirrored low')
    near(down.high, -up.low, 'mirrored high')
  })

  test('equal rates are centred on 0, and a single run each is too few to tell', () => {
    const same = liftInterval({ pass: 3, n: 5 }, { pass: 3, n: 5 })
    assert.equal(same.points, 0)
    near(same.low, -same.high, 'symmetric')
    const one = liftInterval({ pass: 1, n: 1 }, { pass: 0, n: 1 })
    assert.ok(one.low < 0 && one.high > 0, `1/1 vs 0/1 spans 0: [${one.low}, ${one.high}]`)
  })

  test('twin: a single Wilson interval on the difference would be wrong', () => {
    // Treating 56/70 − 48/80 as one proportion gives a different (and meaningless) interval.
    const wrong = wilson(Math.round(0.2 * 70), 70)
    assert.ok(Math.abs(wrong.low - 0.0524) > 0.01, 'the check tells the two methods apart')
  })
})

describe('gate policies', () => {
  const runs = (spec: string): Outcome[] =>
    [...spec].map((c) => ({ p: 'pass', f: 'fail', i: 'infra_error', s: 'skipped' })[c] as Outcome)
  const cases: Array<[string, Parameters<typeof cellOutcome>[1], Outcome]> = [
    ['ppppf', 'all', 'fail'],
    ['ppppp', 'all', 'pass'],
    ['ppppf', { passRate: 0.8 }, 'pass'],
    ['pppff', { passRate: 0.8 }, 'fail'],
    ['ppppf', { passRate: 0.9 }, 'fail'],
    ['ppppi', { passRate: 1 }, 'pass'],
    ['iiiii', { passRate: 0.5 }, 'infra_error'],
    ['sssss', { passRate: 0.5 }, 'skipped'],
    ['ppppf', 'none', 'fail'],
  ]
  for (const [spec, gate, outcome] of cases) {
    test(`${spec} under ${JSON.stringify(gate)} is ${outcome}`, () => {
      assert.equal(cellOutcome(runs(spec), gate), outcome)
    })
  }

  test("more runs don't make a steady 80% agent fail a rate gate", () => {
    for (const n of [5, 10, 20]) {
      const outcomes = runs('p'.repeat(n * 0.8) + 'f'.repeat(n * 0.2))
      assert.equal(cellOutcome(outcomes, { passRate: 0.8 }), 'pass', `${n} runs`)
      assert.equal(cellOutcome(outcomes, 'all'), 'fail', `${n} runs under 'all'`)
    }
  })

  test('the option takes all or { passRate } in (0, 1]', () => {
    checkGate('all', 'e')
    checkGate({ passRate: 1 }, 'e')
    for (const bad of ['any', { passRate: 0 }, { passRate: 1.2 }, { rate: 0.8 }, {}, 0.8]) {
      assert.throws(() => checkGate(bad, 'e'), /gate is 'all' .* or \{ passRate \}/)
    }
  })
})

describe('fingerprints and keys', () => {
  test('a cell fingerprint is the hash of its parts, so each part can be compared', () => {
    const parts: FingerprintParts = {
      sources: 'a',
      harness: 'b',
      environment: null,
      image: null,
      agentCli: null,
      judge: 'c',
      context: 'd',
    }
    const hash = createHash('sha256').update(JSON.stringify(parts)).digest('hex')
    assert.equal(fingerprintOf(parts), hash)
    assert.notEqual(fingerprintOf({ ...parts, judge: 'other' }), hash, 'twin: a part changes it')
  })

  test('judgement keys follow position and question', () => {
    assert.equal(judgementKey(0, 'q'), judgementKey(0, 'q'))
    assert.notEqual(judgementKey(0, 'q'), judgementKey(1, 'q'))
    assert.notEqual(judgementKey(0, 'q'), judgementKey(0, 'q?'))
    assert.match(judgementKey(2, 'q'), /^2:[0-9a-f]{12}$/)
  })
})

describe('traced sources', () => {
  test("an eval's local imports are traced transitively; packages and unrelated files aren't", async () => {
    const root = tempDir('sources')
    const write = (path: string, text: string) => {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    write(
      'evals/a.eval.ts',
      `import { evaluate } from 'reeval'\nimport { h } from './helpers.ts'\n`,
    )
    write(
      'evals/helpers.ts',
      `export * from '../shared/env.js'\nexport const h = await import('./lazy')\n`,
    )
    write('shared/env.ts', `import 'node:fs'\nexport const e = 1\n`)
    write('evals/lazy.ts', 'export {}\n')
    write('evals/unrelated.ts', 'export {}\n')
    write('node_modules/pkg/index.js', 'export {}\n')
    symlinkSync(join(root, 'node_modules/pkg'), join(root, 'evals/pkg'))
    write('evals/b.eval.ts', `import './pkg/index.js'\n`)
    const paths = (await traceSources(root, 'evals/a.eval.ts')).map((s) => s.path)
    assert.deepEqual(paths, [
      'evals/a.eval.ts',
      'evals/helpers.ts',
      'evals/lazy.ts',
      'shared/env.ts',
    ])
    const own = await traceSources(root, 'evals/b.eval.ts')
    assert.equal(own.length, 2, 'a symlinked package is traced by its link path, once')
  })
})

describe('CI pull request provenance', () => {
  test('GitHub pull_request runs record the number and base branch', () => {
    const r = runnerInfo({
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_REF: 'refs/pull/42/merge',
      GITHUB_BASE_REF: 'main',
    })
    assert.equal(r.kind, 'ci')
    assert.deepEqual(r.kind === 'ci' ? r.pr : null, { number: 42, baseRef: 'main' })
  })

  test('push runs and GitLab merge requests', () => {
    const push = runnerInfo({ CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main' })
    assert.equal(push.kind === 'ci' ? push.pr : 'x', null)
    const gl = runnerInfo({
      CI: 'true',
      GITLAB_CI: 'true',
      CI_MERGE_REQUEST_IID: '7',
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'develop',
    })
    assert.deepEqual(gl.kind === 'ci' ? gl.pr : null, { number: 7, baseRef: 'develop' })
  })
})

describe('compare question pairs', () => {
  const side = (harness: string, arm: string, run: number, checksPassed = true): PairAttempt => ({
    harness,
    arm,
    run,
    diff: `diff --git a/${harness}-${arm}-${run}.txt b/${harness}-${arm}-${run}.txt\n+${harness}\n`,
    checksPassed,
    prompts: ['Write the file.'],
  })
  const matrix = (harnesses: string[], arms: string[], runs: number) =>
    harnesses.flatMap((h) =>
      arms.flatMap((a) => Array.from({ length: runs }, (_, i) => side(h, a, i + 1))),
    )
  const fake = (vote: FakeAnalysisModel['vote']): FakeAnalysisModel => ({
    kind: 'fake-analysis',
    vote,
  })
  const ask = (pairs: ReturnType<typeof pairsOf>, vote: FakeAnalysisModel['vote']) =>
    answerQuestion({
      question: 'Which is cleaner?',
      model: fake(vote),
      pairs,
      maxInputTokens: 20_000,
      maxOutputTokens: 100,
    })

  test('4 harnesses × 2 arms × N runs is 4N within pairs and 6N across pairs', () => {
    for (const n of [1, 3]) {
      const pairs = pairsOf(matrix(['h1', 'h2', 'h3', 'h4'], ['sdk', 'ui'], n))
      assert.equal(pairs.filter((p) => p.cut === 'within').length, 4 * n)
      assert.equal(pairs.filter((p) => p.cut === 'across').length, 6 * n * 2, 'six per arm per run')
      for (const p of pairs) {
        assert.equal(p.a.run, p.b.run, 'a pair is one run')
        if (p.cut === 'within') assert.equal(p.a.harness, p.b.harness)
        else assert.equal(p.a.arm, p.b.arm)
      }
    }
  })

  test('the control arm is a within a harness, whichever attempt came first', () => {
    const [pair] = pairsOf([
      side('h', 'variant', 1),
      { ...side('h', 'baseline', 1), control: true },
    ])
    assert.deepEqual([pair?.a.arm, pair?.b.arm], ['baseline', 'variant'])
  })

  test('an attempt that failed its checks is in no pair', () => {
    const attempts = matrix(['h1', 'h2'], ['sdk', 'ui'], 2)
    const failed = attempts.find((a) => a.harness === 'h2' && a.arm === 'ui' && a.run === 2)
    if (failed) failed.checksPassed = false
    const pairs = pairsOf(attempts)
    assert.ok(!pairs.some((p) => p.a === failed || p.b === failed))
    // Without it, h2's run-2 arms and run 2's ui harnesses have no pair; the rest stand.
    assert.equal(pairs.filter((p) => p.cut === 'within').length, 3)
    assert.equal(pairs.filter((p) => p.cut === 'across').length, 3)
  })

  test('every pair is sent twice, swapped, and each pick maps back to its name', async () => {
    const pairs = pairsOf(matrix(['h1', 'h2'], ['sdk', 'ui'], 1))
    const seen: BlindPair[] = []
    const answer = await ask(pairs, (p) => {
      seen.push(p)
      return 'A'
    })
    assert.equal(answer.error, undefined)
    assert.equal(answer.votes.length, pairs.length * 2)
    assert.equal(seen.length, pairs.length * 2)
    for (const pair of pairs) {
      const votes = answer.votes.filter(
        (v) =>
          v.cut === pair.cut &&
          v.run === pair.run &&
          (pair.cut === 'within' ? v.harness === pair.harness : v.arm === pair.arm),
      )
      assert.deepEqual(
        votes.map((v) => [v.swapped, v.winner]),
        [
          [false, pair.cut === 'within' ? pair.a.arm : pair.a.harness],
          [true, pair.cut === 'within' ? pair.b.arm : pair.b.harness],
        ],
        'always picking the first slot picks each side once',
      )
      const [first, second] = [
        blindPair('Which is cleaner?', pair, false, 20_000),
        blindPair('Which is cleaner?', pair, true, 20_000),
      ]
      assert.equal(first.a, second.b)
      assert.equal(first.b, second.a)
      assert.ok(first.a.includes(`+${pair.a.harness}`), 'a pair is two diffs')
    }
  })

  test('the labels and prompt name no arm or harness', () => {
    const [pair] = pairsOf([side('secret-harness', 'arm-x', 1), side('secret-harness', 'arm-y', 1)])
    assert.ok(pair)
    const blind = blindPair(
      'Which?',
      { ...pair, a: { ...pair.a, diff: '+one\n' }, b: { ...pair.b, diff: '+two\n' } },
      false,
      20_000,
    )
    for (const name of ['secret-harness', 'arm-x', 'arm-y', 'run 1', 'baseline', 'variant']) {
      assert.ok(!blind.prompt.includes(name), `${name} is not in the prompt`)
    }
    assert.match(blind.prompt, /<attempt label="A">\n\+one\n\n<\/attempt>/)
    assert.match(blind.prompt, /<task>\nWrite the file\.\n<\/task>/)
  })

  test('rates count wins over decided votes; ties count for neither side', () => {
    const [pair] = pairsOf([side('h', 'sdk', 1), side('h', 'ui', 1)])
    assert.ok(pair)
    const votes = [
      voteOf('q', pair, false, 'B'),
      voteOf('q', pair, true, 'A'),
      voteOf('q', pair, false, 'tie'),
      voteOf('q', pair, true, 'B'),
    ]
    assert.deepEqual(
      votes.map((v) => v.winner),
      ['ui', 'ui', 'tie', 'sdk'],
    )
    assert.deepEqual(ratesOf(votes), [
      { cut: 'within', name: 'sdk', wins: 1, n: 3 },
      { cut: 'within', name: 'ui', wins: 2, n: 3 },
    ])
  })

  test('a model error is kept on the answer, with no votes', async () => {
    const pairs = pairsOf(matrix(['h1'], ['sdk', 'ui'], 1))
    const answer = await ask(pairs, { error: 'quota exceeded' })
    assert.deepEqual(answer, {
      question: 'Which is cleaner?',
      model: 'fake',
      votes: [],
      rates: [],
      error: 'quota exceeded',
    })
  })

  test("a staged attempt's checks held when it passed, or failed on a judge only", () => {
    const e = (state: EngineEval['state']) =>
      ({
        state,
        attempt: { cell: { key: 'h/sdk/fake', harness: 'h', environment: 'sdk' }, n: 2 },
      }) as unknown as EngineEval
    const record = (kind?: 'judge' | 'assertion') =>
      ({
        diff: { patch: '+x\n' },
        error: kind ? { kind, message: '' } : null,
        turns: [{ prompt: 'go' }],
      }) as unknown as EvalRecord
    assert.equal(stagedAttempt(e('passed'), record())?.checksPassed, true)
    assert.equal(stagedAttempt(e('failed'), record('judge'))?.checksPassed, true)
    assert.equal(stagedAttempt(e('failed'), record('assertion'))?.checksPassed, false)
    assert.equal(stagedAttempt(e('skipped'), null)?.checksPassed, false)
    assert.deepEqual(stagedAttempt(e('passed'), record()), {
      harness: 'h',
      arm: 'sdk',
      run: 2,
      diff: '+x\n',
      checksPassed: true,
      control: false,
      prompts: ['go'],
      id: 'h/sdk/fake#2',
    })
  })
})

// The nightly contract's e2e runs: one eval, recorded twice on each of Cursor, Claude Code and
// Codex. Their two runs stand in for two arms, so the real diffs give within and across pairs.
describe('compare questions over real-harness runs (real-e2e-pairs)', () => {
  const attempts = realAttempts('real-e2e-pairs')
  const arms = [...E2E_ARMS]
  const sides = e2ePairSides()
  const pairs = pairsOf(sides)

  test('within: each harness’s two runs; across: the three harnesses per run', () => {
    assert.ok(
      sides.every((s) => s.checksPassed),
      'every e2e attempt passed',
    )
    assert.deepEqual(
      pairs.filter((p) => p.cut === 'within').map((p) => [p.harness, p.a.arm, p.b.arm]),
      REAL_HARNESSES.map((h) => [h, 'first-run', 'second-run']),
    )
    assert.deepEqual(
      pairs.filter((p) => p.cut === 'across').map((p) => [p.arm, p.a.harness, p.b.harness]),
      arms.flatMap((arm) => [
        [arm, 'cursor', 'claude-code'],
        [arm, 'cursor', 'codex'],
        [arm, 'claude-code', 'codex'],
      ]),
    )
  })

  test('each pair goes in both orders, blinded, with the two real diffs', async () => {
    const seen: BlindPair[] = []
    const answer = await answerQuestion({
      question: 'Which ends hello.txt with a newline?',
      model: {
        kind: 'fake-analysis',
        vote: (p) => {
          seen.push(p)
          return newlineVote(p)
        },
      },
      pairs,
      maxInputTokens: 20_000,
      maxOutputTokens: 100,
    })
    assert.equal(seen.length, pairs.length * 2)
    const names = [
      ...REAL_HARNESSES,
      'claude',
      'composer',
      'haiku',
      'gpt-',
      ...arms,
      ...new Set(attempts.map((a) => a.runId)),
    ]
    for (const [i, pair] of pairs.entries()) {
      const [first, second] = [seen[i * 2], seen[i * 2 + 1]] as [BlindPair, BlindPair]
      assert.ok(first.prompt.includes(patchForJudge(pair.a.diff).trimEnd()), 'A is a real diff')
      assert.ok(first.prompt.includes(patchForJudge(pair.b.diff).trimEnd()), 'B is a real diff')
      assert.equal(first.a, second.b, 'the repeat swaps the order')
      assert.equal(first.b, second.a)
      assert.match(first.prompt, /Create a file named hello\.txt/, 'the task both were given')
      for (const name of names) {
        assert.ok(!first.prompt.toLowerCase().includes(name), `${name} is not in the prompt`)
      }
    }
    assert.equal(answer.error, undefined)
    assert.equal(answer.votes.length, 18)
    assert.equal(answer.votes.filter((v) => v.swapped).length, 9)
    assert.equal(answer.votes.filter((v) => v.winner === 'tie').length, 10)
    assert.ok(
      answer.votes.filter((v) => v.winner !== 'tie').every((v) => v.winner === 'codex'),
      'the side with the newline wins in either order',
    )
    assert.deepEqual(answer.rates, [
      { cut: 'across', name: 'cursor', wins: 0, n: 4 },
      { cut: 'across', name: 'codex', wins: 8, n: 8 },
      { cut: 'across', name: 'claude-code', wins: 0, n: 4 },
    ])
  })
})
