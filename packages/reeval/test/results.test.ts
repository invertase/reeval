// What a result means: gate policies, lift with its interval, and what a
// fingerprint covers. Pure functions here; the CLI behaviour is in options.test.ts and
// history.test.ts.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { recordFailure } from '../src/attempt/record.ts'
import type { Attempt } from '../src/attempt/state.ts'
import {
  acrossOf,
  headToHeadLines,
  type PairAttempt,
  pairsOf,
  pairTallies,
  ratesOf,
  sampleReasons,
  splitsLabel,
  VOTE_REASON_CAP,
  voteOf,
} from '../src/compare/pairs.ts'
import {
  answerQuestion,
  blindInput,
  blindPair,
  questionRequest,
  stagedAttempt,
} from '../src/compare/questions.ts'
import { DEFAULT_QUESTION_STATE } from '../src/compare/state.ts'
import type { EngineEval } from '../src/engine/node.ts'
import { defineEnvironment } from '../src/environment.ts'
import { TimeoutError } from '../src/errors.ts'
import { bodyHash, canonicalJson, caseHash, optionsHash, sourcesPart } from '../src/eval-source.ts'
import { fingerprintOf, judgementKey, mergeOutcome } from '../src/history/assemble.ts'
import { familiesOf } from '../src/history/families.ts'
import { runnerInfo } from '../src/history/provenance.ts'
import type { EvalEntry, FamilyLift, FingerprintParts } from '../src/history/types.ts'
import { patchForJudge } from '../src/judge/patch.ts'
import { checkGate } from '../src/options.ts'
import {
  containsZero,
  liftInterval,
  mcnemar,
  meanInterval,
  PAIRED_MIN,
  pairedLiftInterval,
  signedRank,
  t975,
  wilson,
} from '../src/stats.ts'
import type { BlindPair, EvalRecord, FakeAnalysisModel, Outcome } from '../src/types.ts'
import { EFFORT_MIN_RUNS, effortVerdict } from '../src/view/effort.ts'
import { cellOutcome } from '../src/view/gate.ts'
import {
  E2E_ARMS,
  e2ePairSides,
  newlineVote,
  REAL_HARNESSES,
  realAttempts,
} from './support/real-runs.ts'

const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 5e-4, `${what}: ${actual} is not ${expected}`)

/** One family case: variant passes, variant counted, control passes, control counted. */
type FamilyCase = [number, number, number, number]

/** The pooled lift of variant cell `v` over control `c` across `cases`. */
function familyLift(cases: FamilyCase[]): FamilyLift {
  const attempts = (cell: string, pass: number, counted: number) =>
    Array.from({ length: counted }, (_, i) => ({
      cell,
      outcome: i < pass ? 'pass' : 'fail',
      activity: { tools: 1, fileEdits: 0 },
      timings: { agentMs: 1000 },
    }))
  const evals = cases.map(
    ([vPass, vCounted, cPass, cCounted], i) =>
      ({
        file: 'family.eval.ts',
        family: { id: 'family', name: 'family', case: i, cases: cases.length },
        cells: [
          { key: 'v', role: 'variant', harness: 'cursor', sandbox: 'docker' },
          { key: 'c', role: 'control', harness: 'cursor', sandbox: 'docker' },
        ],
        attempts: [...attempts('v', vPass, vCounted), ...attempts('c', cPass, cCounted)],
      }) as unknown as EvalEntry,
  )
  const [family] = familiesOf(evals, () => undefined)
  const lift = family?.lifts[0]
  assert.ok(lift, 'the family has a lift')
  return lift
}

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

describe("paired lift over a pooled family's cases", () => {
  // Reference values: Newcombe (1998), "… based on paired data", table III, method 10.
  const cases: Array<[number, number, number, number, number, number]> = [
    [36, 12, 2, 0, 0.0569, 0.3404],
    [20, 12, 2, 16, 0.0562, 0.3292],
    [18, 12, 2, 18, 0.0562, 0.329],
    [30, 0, 0, 24, -0.0358, 0.0358],
  ]
  for (const [both, variantOnly, controlOnly, neither, low, high] of cases) {
    test(`Newcombe method 10: ${both}, ${variantOnly}, ${controlOnly}, ${neither} is [${low}, ${high}]`, () => {
      const i = pairedLiftInterval({ both, variantOnly, controlOnly, neither })
      near(
        i.points,
        (variantOnly - controlOnly) / (both + variantOnly + controlOnly + neither),
        'points',
      )
      near(i.low, low, 'low')
      near(i.high, high, 'high')
    })
  }

  test('the paired interval is narrower than the independent one on the same rates', () => {
    const paired = pairedLiftInterval({ both: 20, variantOnly: 12, controlOnly: 2, neither: 16 })
    const independent = liftInterval({ pass: 32, n: 50 }, { pass: 22, n: 50 })
    assert.ok(paired.high - paired.low < independent.high - independent.low)
  })

  test("McNemar's exact p is the sign test on the discordant pairs", () => {
    near(mcnemar(12, 2), 0.0129, 'StatsDirect: 12 vs 2')
    const six = mcnemar(6, 0)
    assert.ok(Math.abs(six - 2 * 0.5 ** PAIRED_MIN) < 1e-12, 'six discordant pairs reach p < 0.05')
    assert.ok(mcnemar(5, 0) > 0.05)
    assert.ok(Math.abs(mcnemar(5, 0) - 0.0625) < 1e-12)
    assert.ok(Math.abs(mcnemar(10, 2) - 0.0386) < 1e-4)
    assert.equal(mcnemar(0, 0), 1)
  })

  test("McNemar's p stays finite from 1,024 discordant pairs", () => {
    const even = mcnemar(512, 512)
    assert.ok(Math.abs(even - 1) < 1e-6, `512 vs 512: ${even}`)
    const close = mcnemar(1500, 1400)
    assert.ok(Math.abs(close - 0.066) < 1e-3, `SciPy: 1500 vs 1400 is 0.066, not ${close}`)
    assert.ok(Number.isFinite(mcnemar(600, 500)))
    const lopsided = mcnemar(1100, 5)
    assert.ok(lopsided > 0 && lopsided < 1e-300, `1100 vs 5: ${lopsided}`)
  })

  test('an interval that touches 0 contains it', () => {
    assert.equal(containsZero(-0.5, 0.5), true)
    assert.equal(containsZero(-0.883, 0), true)
    assert.equal(containsZero(0, 0.2), true)
    assert.equal(containsZero(0, 0), true)
    assert.equal(containsZero(0.001, 0.2), false)
    assert.equal(containsZero(-0.2, -0.001), false)
  })

  test('a family interval rounded to end at 0 is within noise', () => {
    // Eight cases at one attempt a side: the variant wins one, the control six, one both fail.
    const family = familyLift([
      [1, 1, 0, 1],
      ...Array.from({ length: 6 }, (): FamilyCase => [0, 1, 1, 1]),
      [0, 1, 0, 1],
    ])
    assert.ok(family.interval.hi === 0, `rounds to end at 0: ${family.interval.hi}`)
    assert.equal(family.verdict, 'noise')
    assert.equal(family.withinNoise, true)
  })

  test('equal family differences tie in the signed-rank p, whichever counts made them', () => {
    // −1/3 and +1/3 share the smallest rank; as 0/3 − 1/3 and 3/3 − 2/3 they'd differ by an ulp.
    const thirds = familyLift([
      [0, 3, 0, 3],
      [0, 3, 0, 3],
      [0, 3, 0, 3],
      [0, 3, 1, 3],
      [2, 3, 0, 3],
      [3, 3, 2, 3],
    ])
    assert.equal(thirds.p, 0.75)
    const mixed = familyLift([
      [1, 2, 1, 3],
      [2, 3, 1, 2],
      [0, 2, 1, 3],
      [3, 3, 2, 3],
      [1, 3, 1, 3],
      [2, 2, 1, 2],
    ])
    assert.equal(mixed.p, 0.375, 'unequal counted: the sixths tie, and so do the thirds')
    const same = familyLift(Array.from({ length: 6 }, (): FamilyCase => [1, 3, 1, 3]))
    assert.equal(same.p, null, 'every difference zero')
  })

  test('the t interval over per-case differences', () => {
    const i = meanInterval([1, 0, 1, 1, 0.5])
    near(i.mean, 0.7, 'mean')
    near(i.low, 0.7 - 2.776 * 0.2, 'low')
    near(i.high, 0.7 + 2.776 * 0.2, 'high')
    assert.equal(meanInterval([1]).low, Number.NEGATIVE_INFINITY, 'one case bounds nothing')
    assert.equal(t975(30), 2.042)
    near(t975(1000), 1.962, 'Cornish–Fisher above the table')
  })

  test('the signed-rank p: exact, with mid-ranks, and normal above 20', () => {
    assert.deepEqual(signedRank([1, 2, 3, 4, 5, 6]), { p: 2 / 64, sign: 1 })
    assert.deepEqual(signedRank([-1, -2, -3, -4, -5, -6]), { p: 2 / 64, sign: -1 }, 'two-sided')
    assert.equal(signedRank([0, 0]), null, 'every difference zero')
    assert.deepEqual(signedRank([1, -1]), { p: 1, sign: 0 })
    const many = signedRank(Array.from({ length: 25 }, (_, i) => i + 1))
    assert.ok(many && many.p < 0.001 && many.sign === 1, `25 positive differences: ${many?.p}`)
  })

  test("a family's effort direction is the signed-rank test's, even when most cases tie", () => {
    // Thirteen cases: seven use the same tool calls on both sides, six use one fewer on the
    // variant. The median difference is 0; the six non-zero differences all say fewer.
    const evals = Array.from({ length: 13 }, (_, i) => {
      const attempt = (cell: string, tools: number) => ({
        cell,
        outcome: 'pass',
        activity: { tools, fileEdits: 0 },
        timings: { agentMs: 1000 },
      })
      return {
        file: 'family.eval.ts',
        family: { id: 'family', name: 'family', case: i, cases: 13 },
        cells: [
          { key: 'v', role: 'variant', harness: 'cursor', sandbox: 'docker' },
          { key: 'c', role: 'control', harness: 'cursor', sandbox: 'docker' },
        ],
        attempts: [attempt('v', i < 6 ? 2 : 3), attempt('c', 3)],
      } as unknown as EvalEntry
    })
    const tools = familiesOf(evals, () => undefined)[0]?.lifts[0]?.effort.tools
    assert.equal(tools?.p, 0.031)
    assert.equal(tools?.verdict, 'fewer')
  })
})

describe('the effort verdict', () => {
  test('its direction is the rank test’s, even when the medians are equal', () => {
    const variant = [0, 0, 0, 0, 1, 1, 1, 1, 1, 1]
    const control = [1, 1, 1, 1, 1, 1, 100, 100, 100, 100]
    const fewer = effortVerdict(variant, control)
    assert.equal(fewer.verdict, 'fewer')
    assert.ok((fewer.p ?? 1) < 0.05, `p ${fewer.p}`)
    assert.equal(effortVerdict(control, variant).verdict, 'more')
    assert.equal(effortVerdict([1, 1, 1, 2, 2], [1, 1, 2, 2, 2]).verdict, 'noise')
  })

  test('whether it can be tested depends on the ties, not only the counts', () => {
    const win = effortVerdict([1, 2, 3], [4, 4, 4, 4])
    assert.equal(win.verdict, 'fewer', 'one extreme ordering, not two: 1/35')
    assert.ok(Math.abs((win.p ?? 1) - 1 / 35) < 1e-9)
    assert.equal(effortVerdict([2, 2, 2, 3], [2, 2, 3, 3]).verdict, 'insufficient', 'floor 10/70')
    assert.equal(effortVerdict([2, 2, 2, 2], [2, 2, 2, 2]).verdict, 'insufficient')
    const flat = effortVerdict(Array(20).fill(5), Array(20).fill(5))
    assert.equal(flat.verdict, 'insufficient', 'the normal approximation, all tied')
    assert.ok(!Number.isNaN(flat.p))
    const ties = effortVerdict([...Array(19).fill(5), 6], Array(20).fill(5))
    assert.equal(ties.verdict, 'insufficient', 'the normal approximation, nearly all tied')
    assert.equal(effortVerdict([1, 2, 3], [4, 5, 6]).verdict, 'insufficient', 'untied 3 vs 3')
    const four = effortVerdict([1, 2, 3, 4], [5, 6, 7, 8])
    assert.equal(four.verdict, 'fewer')
    assert.ok(Math.abs((four.p ?? 1) - 2 / 70) < 1e-9, 'untied 4 vs 4 is 2/70')
    assert.equal(EFFORT_MIN_RUNS, 4)
  })
})

describe('mergeOutcome and abort classification', () => {
  const failed = (errorName?: string, message = 'Eval timed out after 1s'): EngineEval =>
    ({ state: 'failed', errors: [message], errorName }) as EngineEval

  test('without a record, TimeoutError is a timeout and a "timed out" message is not', () => {
    assert.equal(mergeOutcome(failed('TimeoutError'), null).error?.kind, 'timeout')
    assert.equal(
      mergeOutcome(failed(undefined, 'setup step 1/1 "sleep" timed out after 1s'), null).error
        ?.kind,
      'assertion',
    )
  })

  test('a skipped attempt keeps a staged pass, so a resume does not turn it into skipped', () => {
    const record = {
      outcome: 'pass',
      error: null,
    } as EvalRecord
    assert.deepEqual(mergeOutcome({ state: 'skipped', errors: [] } as EngineEval, record), {
      outcome: 'pass',
      error: null,
    })
    assert.deepEqual(mergeOutcome({ state: 'skipped', errors: [] } as EngineEval, null), {
      outcome: 'skipped',
      error: null,
    })
  })

  test("the worker's record wins, including an infra error whose message says timed out", () => {
    const record = {
      outcome: 'infra_error',
      error: { kind: 'infra', message: 'setup step timed out after 1s' },
    } as EvalRecord
    assert.deepEqual(mergeOutcome(failed('TimeoutError'), record), {
      outcome: 'infra_error',
      error: record.error,
    })
  })

  test('recordFailure classifies an abort by TimeoutError, not the message', () => {
    const attempt = (signal: AbortSignal) =>
      ({
        record: { error: null, judgements: [], outcome: 'pass' },
        signal,
        judgeThrown: new Set(),
      }) as unknown as Attempt

    const timeout = new AbortController()
    timeout.abort(new TimeoutError('Eval timed out after 1s'))
    const timedOut = attempt(timeout.signal)
    recordFailure(timedOut, new Error('ignored'), false, [])
    assert.deepEqual(timedOut.record.error, { kind: 'timeout', message: 'The eval timed out' })

    const cancel = new AbortController()
    cancel.abort(Object.assign(new Error('The run was cancelled'), { name: 'AbortError' }))
    const cancelled = attempt(cancel.signal)
    recordFailure(cancelled, new Error('ignored'), false, [])
    assert.deepEqual(cancelled.record.error, {
      kind: 'aborted',
      message: 'The run was cancelled',
    })

    const setup = new AbortController()
    setup.abort(new Error('setup step 1/1 "sleep" timed out after 1s'))
    const other = attempt(setup.signal)
    recordFailure(other, new Error('setup timed out'), false, [])
    assert.deepEqual(other.record.error, { kind: 'aborted', message: 'The run was cancelled' })
  })
})

describe('gate policies', () => {
  const runs = (spec: string): Outcome[] =>
    [...spec].map((c) => ({ p: 'pass', f: 'fail', i: 'infra_error', s: 'skipped' })[c] as Outcome)
  const cases: Array<[string, Parameters<typeof cellOutcome>[1], Outcome]> = [
    ['ppppf', 'all', 'fail'],
    ['ppppp', 'all', 'pass'],
    ['ppppi', 'all', 'pass'],
    ['pppfi', 'all', 'fail'],
    ['iiiii', 'all', 'infra_error'],
    ['issss', 'all', 'infra_error'],
    ['ppppf', { passRate: 0.8 }, 'pass'],
    ['pppff', { passRate: 0.8 }, 'fail'],
    ['ppppf', { passRate: 0.9 }, 'fail'],
    ['ppppi', { passRate: 1 }, 'pass'],
    ['iiiii', { passRate: 0.5 }, 'infra_error'],
    ['sssss', { passRate: 0.5 }, 'skipped'],
    ['ppppf', 'none', 'fail'],
    ['ppppi', 'none', 'infra_error'],
  ]
  for (const [spec, gate, outcome] of cases) {
    test(`${spec} under ${JSON.stringify(gate)} is ${outcome}`, () => {
      assert.equal(cellOutcome(runs(spec), gate), outcome)
    })
  }

  test("'all' matches { passRate: 1 }: infra only when nothing counted", () => {
    assert.equal(cellOutcome(runs('ppppi'), 'all'), cellOutcome(runs('ppppi'), { passRate: 1 }))
    assert.equal(cellOutcome(runs('iiiii'), 'all'), cellOutcome(runs('iiiii'), { passRate: 1 }))
    assert.equal(cellOutcome(runs('ppppi'), 'all'), 'pass')
    assert.equal(cellOutcome(runs('iiiii'), 'all'), 'infra_error')
  })

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
      assert.throws(() => checkGate(bad, 'e'), /gate in e is 'all' .* or \{ passRate \}/)
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

describe("an eval's source", () => {
  const body = 'a'.repeat(64)

  test('canonical JSON sorts keys, drops undefined, and reads a function as its source', () => {
    assert.equal(canonicalJson({ b: 1, a: [undefined, 2], c: undefined }), '{"a":[null,2],"b":1}')
    assert.equal(canonicalJson({ f: () => 1 }), '{"f":"() => 1"}')
    const env = defineEnvironment('skilled', { files: { 'a.txt': 'a' } })
    assert.equal(canonicalJson({ env }), '{"env":{"environment":"skilled"}}')
  })

  test('the options hash leaves out tags, revision and gate, and reads harnesses and sandboxes by id', () => {
    const base = optionsHash([{ runs: 2 }])
    assert.equal(optionsHash([{ runs: 2, tags: ['slow'], revision: 3, gate: 'all' }]), base)
    assert.equal(optionsHash([{}, { runs: 2 }]), base, 'an option-less group adds nothing')
    assert.notEqual(optionsHash([{ runs: 3 }]), base, 'twin: another option changes it')
    assert.notEqual(optionsHash([{ runs: 2 }, { runs: 2 }]), base, 'a group level is its own')
    const at = (dir: string) => ({
      sandbox: { kind: 'docker' as const, dockerfile: join(dir, 'docker', 'Dockerfile') },
    })
    assert.equal(optionsHash([at('/one')]), optionsHash([at('/two')]), 'no host paths')
  })

  test('the sources part covers the source and revision, and 2 is not "2"', () => {
    const source = { body, options: 'b'.repeat(64) }
    const none = sourcesPart(source, undefined)
    assert.notEqual(sourcesPart(source, 2), none)
    assert.notEqual(sourcesPart(source, 2), sourcesPart(source, '2'))
    assert.notEqual(sourcesPart({ ...source, case: 'c'.repeat(64) }, undefined), none)
    assert.equal(sourcesPart({ options: source.options, body }, undefined), none)
  })

  test('a body hashes its own source text; a bound function is refused', () => {
    const a = async () => {}
    const b = async () => {
      await Promise.resolve()
    }
    assert.notEqual(bodyHash(a, 'evaluate("a")'), bodyHash(b, 'evaluate("b")'))
    assert.equal(caseHash({ n: 1, s: 'x' }), caseHash({ s: 'x', n: 1 }))
    assert.throws(
      () => bodyHash(a.bind(null), 'evaluate("bound")'),
      /evaluate\("bound"\)'s body is a bound or built-in function/,
    )
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
    turns: [{ prompt: 'Write the file.', text: `Done on ${harness}.` }],
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

  test('acrossOf: environment keeps environment pairs; harness keeps harness pairs', () => {
    const attempts = matrix(['h1', 'h2', 'h3', 'h4'], ['sdk', 'ui'], 2)
    const environment = pairsOf(attempts, acrossOf('environment'))
    const harness = pairsOf(attempts, acrossOf('harness'))
    const both = pairsOf(attempts, acrossOf())
    assert.equal(environment.length, 8)
    assert.ok(environment.every((p) => p.cut === 'within'))
    assert.equal(harness.length, 24)
    assert.ok(harness.every((p) => p.cut === 'across'))
    assert.deepEqual(
      both.map((p) => p.cut),
      [...environment, ...harness].map((p) => p.cut),
    )
    assert.equal(pairsOf(attempts).length, both.length)
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
      assert.deepEqual(first.a, second.b)
      assert.deepEqual(first.b, second.a)
      assert.ok(first.a.diff?.includes(`+${pair.a.harness}`), 'a pair is two diffs')
      assert.deepEqual(Object.keys(first.a), ['diff'], 'by default a side is its diff alone')
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
    assert.match(blind.prompt, /<attempt label="A">\n<diff>\n\+one\n\n<\/diff>\n<\/attempt>/)
    assert.match(blind.prompt, /<task>\nWrite the file\.\n<\/task>/)
  })

  test('state chooses what each side shows; output and files stay out by default', () => {
    const [pair] = pairsOf([side('h', 'arm-x', 1), side('h', 'arm-y', 1)])
    assert.ok(pair)
    const two = {
      ...pair,
      a: {
        ...pair.a,
        turns: [
          { prompt: 'Write the file.', text: 'I wrote it, beautifully.' },
          { prompt: 'Now test it.', text: 'Tests pass.' },
        ],
        checks: [{ command: 'npm test', exitCode: 0, stdout: '14 passing\n', stderr: '' }],
      },
      b: { ...pair.b, turns: [{ prompt: 'Write the file.', text: 'Done.' }] },
    }
    const plain = blindPair('Which?', two, false, 20_000)
    assert.ok(!plain.prompt.includes('beautifully'), 'no final message by default')
    assert.ok(!plain.prompt.includes('<files>'), 'no file list by default')
    assert.match(
      plain.prompt,
      /<turn n="1">\n<task>\nWrite the file\./,
      'prompts differ: each side has its own',
    )
    const shown = blindPair('Which?', two, false, 20_000, {
      state: {
        ...DEFAULT_QUESTION_STATE,
        output: true,
        diff: false,
        turns: 'last',
        checks: ['npm test'],
      },
    })
    assert.deepEqual(shown.a, {
      task: 'Now test it.',
      output: 'Tests pass.',
      checks: [{ command: 'npm test', exitCode: 0, stdout: '14 passing\n', stderr: '' }],
    })
    assert.deepEqual(shown.b, {
      task: 'Write the file.',
      output: 'Done.',
      checks: [{ command: 'npm test', notRun: true }],
    })
    assert.match(shown.prompt, /\$ npm test → not run/)
    assert.ok(!shown.prompt.includes('<diff>'))
  })

  test('canary: state off drops a part the default shows', () => {
    const [pair] = pairsOf([side('h', 'x', 1), side('h', 'y', 1)])
    assert.ok(pair)
    const blind = blindPair('Which?', pair, false, 20_000, {
      state: { ...DEFAULT_QUESTION_STATE, diff: false, output: true },
    })
    assert.equal(blind.a.diff, undefined)
    assert.notEqual(blind.a.diff, blindPair('Which?', pair, false, 20_000).a.diff)
  })

  test("artifacts send each side's own capture of that name, labelled by position", async () => {
    const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n])
    const [pair] = pairsOf([
      {
        ...side('h', 'arm-x', 1),
        diff: '+one\n',
        captures: [{ name: 'home-of-arm-x', data: png(1) }],
      },
      {
        ...side('h', 'arm-y', 1),
        diff: '+two\n',
        captures: [{ name: 'home-of-arm-y', data: png(2) }],
      },
    ])
    assert.ok(pair)
    const both = blindPair('Which?', pair, false, 20_000, {
      state: DEFAULT_QUESTION_STATE,
      artifacts: true,
    })
    assert.deepEqual(both.a.artifacts, [
      { label: 'Attempt A, screenshot 1 of 1', mediaType: 'image/png', bytes: 5 },
    ])
    for (const name of ['home-of-arm-x', 'home-of-arm-y', 'arm-x', 'arm-y']) {
      assert.ok(!both.prompt.includes(name), `${name} is not in the prompt`)
    }
    const named = blindPair('Which?', pair, true, 20_000, {
      state: DEFAULT_QUESTION_STATE,
      artifacts: ['home-of-arm-x'],
    })
    assert.deepEqual(named.b.artifacts, [
      { label: 'Attempt B, screenshot 1 of 1', mediaType: 'image/png', bytes: 5 },
    ])
    assert.deepEqual(named.a.artifacts, [{ label: 'Attempt A, screenshot 1 of 1', missing: true }])
    const request = questionRequest(
      blindInput('Which?', pair, true, 20_000, { state: DEFAULT_QUESTION_STATE, artifacts: true }),
    )
    assert.ok('messages' in request)
    assert.deepEqual(
      request.messages[0]?.content.map((part) =>
        part.type === 'file' ? [...(part.data as Uint8Array)].at(-1) : part.text.split('\n')[0],
      ),
      ['Question: Which?', 'Attempt A, screenshot 1 of 1', 2, 'Attempt B, screenshot 1 of 1', 1],
      "the prompt, then each side's screenshot after its label, in the order shown",
    )
    assert.match(request.system, /screenshots of its work/)
    assert.ok(!('messages' in questionRequest(blindInput('Which?', pair, false, 20_000))))
    const answer = await answerQuestion({
      question: 'Which page is clearer?',
      model: { kind: 'fake-analysis', vote: 'A' },
      pairs: [pair],
      maxInputTokens: 20_000,
      maxOutputTokens: 100,
      artifacts: ['home-of-arm-x'],
    })
    assert.deepEqual(answer.artifacts, ['home-of-arm-x'])
    assert.deepEqual(
      answer.votes.map((v) => v.artifacts),
      [
        { a: ['home-of-arm-x'], b: [] },
        { a: ['home-of-arm-x'], b: [] },
      ],
      'names per named side, whichever order was shown',
    )
    const missing = await answerQuestion({
      question: 'Which page is clearer?',
      model: { kind: 'fake-analysis', vote: 'A' },
      pairs: [pair],
      maxInputTokens: 20_000,
      maxOutputTokens: 100,
      artifacts: ['home'],
      state: { checks: ['npm tset'] },
    })
    assert.equal(
      missing.error,
      'question "Which page is clearer?" state.checks names a command no paired attempt ran: "npm tset"',
    )
    assert.deepEqual(missing.votes, [])
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

  // Ben's UX question over three arms and three runs: his record's pooled line read no-skill 9/12,
  // current-skill 2/12, new-skill 7/12 and "0 ties", while 4 of the 9 pairs were decided by
  // which attempt was shown first.
  test("head to head: a pair whose two orders disagree is a split, not a win each (Ben's UX votes)", () => {
    const arms = ['no-skill', 'current-skill', 'new-skill']
    const pairs = pairsOf(
      arms.flatMap((arm) =>
        [1, 2, 3].map((run) => ({ ...side('cursor', arm, run), control: arm === 'no-skill' })),
      ),
    )
    // [unswapped pick, swapped pick] per pair and run, in pairsOf's order.
    const picks: Record<string, Array<['A' | 'B', 'A' | 'B']>> = {
      'no-skill current-skill': [
        ['A', 'B'],
        ['A', 'B'],
        ['A', 'A'],
      ],
      'no-skill new-skill': [
        ['A', 'A'],
        ['A', 'A'],
        ['A', 'B'],
      ],
      'current-skill new-skill': [
        ['B', 'A'],
        ['B', 'A'],
        ['A', 'A'],
      ],
    }
    const votes = pairs.flatMap((pair) => {
      const [x, y] = picks[`${pair.a.arm} ${pair.b.arm}`]?.[pair.run - 1] ?? ['A', 'A']
      return [voteOf('UX', pair, false, x), voteOf('UX', pair, true, y)]
    })
    assert.deepEqual(
      ratesOf(votes).map((r) => `${r.name} ${r.wins}/${r.n}`),
      ['no-skill 9/12', 'current-skill 2/12', 'new-skill 7/12'],
      'the pooled rates Ben saw',
    )
    assert.deepEqual(
      pairTallies(votes).map((t) => [t.a, t.b, t.aWins, t.bWins, t.ties, t.splits, t.splitsFirst]),
      [
        ['no-skill', 'current-skill', 2, 0, 0, 1, 1],
        ['no-skill', 'new-skill', 1, 0, 0, 2, 2],
        ['current-skill', 'new-skill', 0, 2, 0, 1, 1],
      ],
    )
    assert.deepEqual(headToHeadLines(votes), [
      'within cursor: no-skill 2–0 current-skill (1 split) · no-skill 1–0 new-skill (2 splits) · current-skill 0–2 new-skill (1 split)',
    ])
    assert.equal(
      splitsLabel(pairTallies(votes)),
      '4/9 pairs split by order, all to the side shown first',
    )
  })

  test('canary: two arms get no head-to-head line, and orders that agree split nothing', () => {
    const pairs = pairsOf(matrix(['h'], ['sdk', 'ui'], 2))
    const votes = pairs.flatMap((pair) => [
      voteOf('q', pair, false, 'B'),
      voteOf('q', pair, true, pair.run === 1 ? 'A' : 'tie'),
    ])
    assert.deepEqual(headToHeadLines(votes), [])
    assert.deepEqual(
      pairTallies(votes).map((t) => [t.aWins, t.bWins, t.ties, t.splits]),
      [[0, 2, 0, 0]],
      'a tie beside a pick decides for the pick',
    )
    assert.equal(splitsLabel(pairTallies(votes)), '0/2 pairs split by order')
    assert.equal(splitsLabel([]), null)
  })

  test('a vote reason is stored, capped and sampled; empty is omitted', async () => {
    const [pair] = pairsOf([side('h', 'sdk', 1), side('h', 'ui', 1)])
    assert.ok(pair)
    const long = `${'x'.repeat(300)} tail`
    assert.equal(
      voteOf('q', pair, false, 'B', '  the skill writes Ahoy  ').reason,
      'the skill writes Ahoy',
    )
    assert.equal(voteOf('q', pair, false, 'B', '   ').reason, undefined)
    assert.equal(voteOf('q', pair, false, 'B').reason, undefined)
    const capped = voteOf('q', pair, false, 'B', long).reason
    assert.ok(capped)
    assert.ok(capped.length <= VOTE_REASON_CAP)
    assert.ok(capped.endsWith('…'))
    const answer = await ask(pairsOf(matrix(['h1'], ['sdk', 'ui'], 1)), {
      winner: 'A',
      reason: 'A added the file',
    })
    assert.ok(answer.votes.every((v) => v.reason === 'A added the file'))
    assert.deepEqual(sampleReasons(answer.votes), ['A added the file'])
  })

  test('a model error is kept on the answer, with no votes', async () => {
    const pairs = pairsOf(matrix(['h1'], ['sdk', 'ui'], 1))
    const answer = await ask(pairs, { error: 'quota exceeded' })
    assert.deepEqual(answer, {
      question: 'Which is cleaner?',
      model: 'fake',
      stateOptions: DEFAULT_QUESTION_STATE,
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
        diff: { patch: '+x\n', files: [] },
        error: kind ? { kind, message: '' } : null,
        turns: [{ prompt: 'go' }],
        checks: [],
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
      files: [],
      checksPassed: true,
      control: false,
      turns: [{ prompt: 'go', text: undefined, transcript: undefined }],
      checks: [],
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
      assert.deepEqual(first.a, second.b, 'the repeat swaps the order')
      assert.deepEqual(first.b, second.a)
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
