// What a result means (plan-of-attack wave 2): gate policies, lift with its interval, and what a
// fingerprint covers. Pure functions here; the CLI behaviour is in options.test.ts and
// history.test.ts.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { cellOutcome, fingerprintOf, judgementKey } from '../src/history/assemble.ts'
import { runnerInfo } from '../src/history/provenance.ts'
import { traceSources } from '../src/history/sources.ts'
import type { FingerprintParts } from '../src/history/types.ts'
import { checkGate } from '../src/options.ts'
import { liftInterval, wilson } from '../src/stats.ts'
import type { Outcome } from '../src/types.ts'
import { tempDir } from './helpers.ts'

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
