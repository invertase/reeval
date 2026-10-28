// `suiteResult`, the facts view-model: every corpus run builds one, three of them against JSON
// goldens (test/fixtures/suite/), the effect table, not-run checks and `reeval run --json`.
// REEVAL_UPDATE_SNAPSHOTS=1 rewrites the goldens; review the diff.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { biome } from '../scripts/schema/check.ts'
import type { CheckTally, RunRecord } from '../src/history/types.ts'
import { render } from '../src/ui/layout.ts'
import { readableRecord } from '../src/view/record.ts'
import {
  checkEffect,
  EFFECT_MIN_COUNTED,
  type Effect,
  effectOf,
  factSegment,
  messageLine,
  type SuiteResult,
  suiteResult,
} from '../src/view/suite.ts'
import { fakeConfig, project, runCli } from './helpers.ts'
import { corpusEntries } from './support/corpus.ts'
import { testDir } from './support/fixture.ts'

const entries = corpusEntries()
const read = (raw: Record<string, unknown>) =>
  readableRecord(structuredClone(raw) as never) as RunRecord

/** Compares with the golden at `test/<path>`; REEVAL_UPDATE_SNAPSHOTS=1 writes it, as Biome formats it. */
function matchJson(path: string, value: unknown): void {
  const file = join(testDir, path)
  if (process.env.REEVAL_UPDATE_SNAPSHOTS === '1') {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
    const r = biome(['format', '--write', file])
    assert.equal(r.status, 0, r.stderr + r.stdout)
    return
  }
  assert.ok(existsSync(file), `No golden at test/${path}. Write it with REEVAL_UPDATE_SNAPSHOTS=1.`)
  const golden = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(value, golden, `test/${path} (REEVAL_UPDATE_SNAPSHOTS=1 rewrites it)`)
}

const pathsOf = (s: SuiteResult) =>
  s.files.flatMap((f) =>
    f.evals.flatMap((e) => [
      e.path,
      ...(e.cases ?? []).map((k) => k.path),
      ...(e.pooled ?? []).map((p) => p.path),
      ...[...(e.cells ?? []), ...(e.cases ?? []).flatMap((k) => k.cells)].flatMap((c) => [
        c.path,
        ...c.checks.map((k) => k.path),
      ]),
    ]),
  )

const cellsOf = (s: SuiteResult) =>
  s.files.flatMap((f) =>
    f.evals.flatMap((e) => [...(e.cells ?? []), ...(e.cases ?? []).flatMap((c) => c.cells)]),
  )

describe('suiteResult over the record corpus', () => {
  for (const entry of entries) {
    for (const run of entry.runs) {
      test(`${entry.name} ${run.runId}`, () => {
        const record = read(run.raw)
        const s = suiteResult(record)
        assert.equal(s.runId, record.runId)
        const paths = pathsOf(s)
        assert.equal(new Set(paths).size, paths.length, 'every path is unique')
        const evals = s.files.flatMap((f) => f.evals)
        for (const e of evals) {
          assert.equal((e.cells === null) !== (e.cases === null), true, 'cells or cases, not both')
          assert.equal(e.family, e.cases !== null)
        }
        // Each eval in the record is one, and a family whose pooled gate failed one more.
        const t = s.tally
        const gates = (record.families ?? []).filter((f) =>
          f.lifts.some((l) => l.outcome === 'fail'),
        ).length
        assert.equal(
          t.pass + t.notGated + t.fail + t.infraError + t.canceled + t.skipped,
          record.evals.length + gates,
        )
        assert.equal(t.errors, record.errors?.length ?? 0)
        assert.deepEqual(
          s.files.map((f) => f.path),
          [...s.files.map((f) => f.path)].sort(),
        )
        for (const c of cellsOf(s)) {
          assert.equal(c.attempts, c.passed + c.failed + c.infraError + c.skipped, c.path)
        }
        assert.deepEqual(suiteResult(record), s, 'pure')
      })
    }
  }

  for (const name of ['fake-matrix', 'with-families', 'real-harnesses']) {
    test(`${name} matches test/fixtures/suite/${name}.json`, () => {
      const entry = entries.find((e) => e.name === name)
      assert.ok(entry, name)
      matchJson(
        `fixtures/suite/${name}.json`,
        Object.fromEntries(entry.runs.map((r) => [r.runId, suiteResult(read(r.raw))])),
      )
    })
  }
})

describe('effect', () => {
  const side = (pass: number, counted: number) => ({ pass, counted })
  const interval = (low: number, high: number) => ({ low, high })
  const cases: Array<[string, Effect, ReturnType<typeof side>, ReturnType<typeof side>]> = [
    ['4 of 4 against 0 of 4 is better', 'better', side(4, 4), side(0, 4)],
    ['4 of 4 against 1 of 4 is better', 'better', side(4, 4), side(1, 4)],
    ['0 of 4 against 4 of 4 is worse', 'worse', side(0, 4), side(4, 4)],
    ['3 of 4 against 2 of 4 is unclear', 'unclear', side(3, 4), side(2, 4)],
    ['4 of 4 against 4 of 4 is the same', 'same', side(4, 4), side(4, 4)],
    ['0 of 4 against 0 of 4 is the same', 'same', side(0, 4), side(0, 4)],
    ['3 of 3 against 0 of 3 is unclear: under 4 a side', 'unclear', side(3, 3), side(0, 3)],
    ['1 of 1 against 1 of 1 is unclear: under 4 a side', 'unclear', side(1, 1), side(1, 1)],
    ['10 of 10 against 0 of 3 is unclear: one side under 4', 'unclear', side(10, 10), side(0, 3)],
  ]
  for (const [name, expected, variant, control] of cases) {
    test(name, () => {
      const t = (s: ReturnType<typeof side>): CheckTally => ({
        pass: s.pass,
        fail: s.counted - s.pass,
        error: 0,
        notRun: 0,
      })
      assert.equal(checkEffect(t(variant), t(control)), expected)
    })
  }

  test('reads the stored interval, never recomputes it', () => {
    assert.equal(effectOf(side(4, 4), side(3, 4), interval(0.01, 0.5)), 'better')
    assert.equal(effectOf(side(3, 4), side(4, 4), interval(-0.5, -0.01)), 'worse')
    assert.equal(effectOf(side(4, 4), side(3, 4), interval(-0.2, 0.5)), 'unclear')
    assert.equal(effectOf(side(4, 4), side(3, 4), null), 'unclear')
    assert.equal(EFFECT_MIN_COUNTED, 4)
  })

  test('a side where the check never ran is not a fail: unclear, not better', () => {
    const notRun: CheckTally = { pass: 0, fail: 0, error: 0, notRun: 4 }
    const passed: CheckTally = { pass: 4, fail: 0, error: 0, notRun: 0 }
    const failed: CheckTally = { pass: 0, fail: 4, error: 0, notRun: 0 }
    assert.equal(checkEffect(passed, notRun), 'unclear')
    assert.equal(checkEffect(notRun, passed), 'unclear')
    // The same 4 attempts, counted as fails, would be a difference.
    assert.equal(checkEffect(passed, failed), 'better')
  })

  test('not-run attempts of a check that ran elsewhere are not counted', () => {
    const partly: CheckTally = { pass: 4, fail: 0, error: 0, notRun: 4 }
    const passed: CheckTally = { pass: 4, fail: 0, error: 0, notRun: 0 }
    assert.equal(checkEffect(partly, passed), 'same')
  })
})

describe('a record with checks that never ran', () => {
  const entry = entries.find((e) => e.name === 'with-named-checks')
  const raw = entry?.runs[0]?.raw as Record<string, unknown>

  /** The skill compare, with 4 counted attempts an arm and the control's checks never reached. */
  function fourEach(): RunRecord {
    const record = read(raw)
    const e = record.evals.find((x) => x.name === 'greets in the house style')
    assert.ok(e)
    e.cells = e.cells.filter((c) => c.harness === 'fake')
    e.attempts = e.attempts.filter((a) => e.cells.some((c) => c.key === a.cell))
    e.attempts = e.attempts.flatMap((a) =>
      [1, 2, 3, 4].map((n) => ({ ...a, id: `${a.cell}#${n}`, n })),
    )
    for (const c of e.cells) {
      const outcome = c.role === 'control' ? 'fail' : 'pass'
      Object.assign(c, {
        runs: 4,
        pass: outcome === 'pass' ? 4 : 0,
        fail: outcome === 'fail' ? 4 : 0,
      })
      c.checks = c.checks?.map((k) =>
        c.role === 'control'
          ? { label: k.label, pass: 0, fail: 0, error: 0, notRun: 4 }
          : { label: k.label, pass: 4, fail: 0, error: 0, notRun: 0 },
      )
      if (c.lift) {
        c.lift = {
          ...c.lift,
          control: { pass: 0, counted: 4 },
          variant: { pass: 4, counted: 4 },
          interval: { lo: 0.307, hi: 1, level: 0.95, method: 'newcombe-wilson' },
          withinNoise: false,
        }
      }
    }
    return record
  }

  test('a check no attempt reached is not run, never 0 of N', () => {
    const s = suiteResult(fourEach())
    const e = s.files.flatMap((f) => f.evals).find((x) => x.name === 'greets in the house style')
    const [control, variant] = e?.cells ?? []
    assert.ok(control && variant)
    assert.equal(e?.across, 'change')
    assert.equal(control.baseline, true)
    assert.equal(variant.vs, control.key)
    for (const k of control.checks) {
      assert.deepEqual(k.outcome, { status: 'not run' })
      assert.equal(k.effect, null)
    }
    for (const k of variant.checks) {
      assert.equal(k.outcome.status, 'ran')
      assert.equal(k.effect, 'unclear', `${k.label}: the baseline never ran it`)
    }
    assert.equal(variant.effect, 'better')
    assert.deepEqual(variant.interval, { low: 0.307, high: 1 })
  })

  test('a baseline with no counted attempt makes each variant check unclear, not null', () => {
    const record = read(raw)
    const e = record.evals.find((x) => x.name === 'greets in the house style')
    const control = e?.cells.find((c) => c.key === 'fake/plain/docker')
    assert.ok(e && control)
    delete control.checks
    Object.assign(control, { pass: 0, fail: 0, infraError: control.runs })
    for (const a of e.attempts) if (a.cell === control.key) a.outcome = 'infra_error'
    const s = suiteResult(record)
    const variant = cellsOf(s).find((c) => c.key === 'fake/with-house-greeting/docker')
    assert.ok(variant?.checks.length)
    assert.equal(variant.vs, control.key)
    for (const k of variant.checks) assert.equal(k.effect, 'unclear', k.label)
    const baseline = cellsOf(s).find((c) => c.key === control.key)
    assert.deepEqual(
      baseline?.checks.map((k) => [k.label, k.outcome.status]),
      variant.checks.map((k) => [k.label, 'not run']),
      'a cell with no counted attempt lists every declared check as not run',
    )
  })

  test("a check's assertion is a failure's message before an error's", () => {
    const record = read(raw)
    const e = record.evals.find((x) => x.name === 'greets in the house style')
    const control = e?.cells.find((c) => c.key === 'fake/plain/docker')
    const attempt = e?.attempts.find((a) => a.cell === control?.key)
    const check = control?.checks?.[0]
    assert.ok(e && control && attempt && check)
    const failed = attempt.assertions?.find((x) => x.label === check.label)
    assert.ok(failed)
    Object.assign(failed, { status: 'fail', message: 'expected it to pass' })
    const errored = { ...attempt, id: `${attempt.id}-e`, n: attempt.n + 1 }
    errored.assertions = [{ ...failed, status: 'error', message: "couldn't read it" }]
    e.attempts.unshift(errored)
    const s = suiteResult(record)
    const k = cellsOf(s)
      .find((c) => c.key === control.key)
      ?.checks.find((x) => x.label === check.label)
    assert.equal(k?.outcome.status === 'ran' && k.outcome.assertion, 'expected it to pass')
  })

  test('effort is set only from 4 counted attempts', () => {
    const s = suiteResult(fourEach())
    const four = cellsOf(s).filter(
      (c) => c.harness === 'fake' && c.path.includes('greets in the house style'),
    )
    assert.ok(four.length)
    for (const c of four) assert.notEqual(c.effort, null, c.path)
    const one = suiteResult(read(raw))
    assert.ok(cellsOf(one).every((c) => c.effort === null))
  })

  test('a path segment escapes %, / and +', () => {
    assert.equal(factSegment('a/b+c%d'), 'a%2Fb%2Bc%25d')
    const s = suiteResult(read(raw))
    const cell = cellsOf(s).find((c) => c.key === 'fake/plain/docker')
    assert.ok(cell)
    assert.equal(
      cell.path,
      'evals%2Fskill.eval.ts › house greeting › greets in the house style/fake+plain+docker',
    )
  })
})

describe('outcomes the record alone has', () => {
  const layouts = entries.find((e) => e.name === 'with-layouts')
  const raw = layouts?.runs.at(-1)?.raw as Record<string, unknown>
  const evalOf = (s: SuiteResult, name: string) =>
    s.files.flatMap((f) => f.evals).find((e) => e.name === name || e.template === name)
  const text = (s: SuiteResult) => render(s, null, { color: false, verbose: false }).join('\n')

  /** An interrupted run, its `writes greet.js` attempt canceled mid-turn. */
  function interrupted(): RunRecord {
    const record = read(raw)
    record.status = 'interrupted'
    const e = record.evals.find((x) => x.name === 'writes greet.js')
    const [cell] = e?.cells ?? []
    const [attempt] = e?.attempts ?? []
    assert.ok(e && cell && attempt)
    e.outcome = 'fail'
    Object.assign(cell, { outcome: 'fail', pass: 0, fail: 1 })
    Object.assign(attempt, {
      outcome: 'fail',
      error: { kind: 'aborted', message: 'The run was canceled' },
      assertions: [],
    })
    return record
  }

  test('an eval whose only failed attempts were canceled is canceled, not a fail', () => {
    const before = suiteResult(read(raw)).tally
    const s = suiteResult(interrupted())
    assert.equal(evalOf(s, 'writes greet.js')?.outcome, 'canceled')
    assert.equal(s.tally.canceled, 1)
    assert.equal(s.tally.fail, before.fail, 'canary: the real fails still count as fails')
    assert.equal(s.tally.pass, before.pass - 1)
    assert.equal(s.outcome, 'skipped', 'an interrupted run, as its exit code 130 has it')
    assert.match(text(s), /^canceled {9}writes greet\.js$/m)
    assert.match(text(s), new RegExp(`^${before.fail} fail · .* · 1 canceled · \\d+ skipped$`, 'm'))
  })

  test('a real failure beside a canceled attempt is still a fail', () => {
    const record = interrupted()
    const e = record.evals.find((x) => x.name === 'writes greet.js')
    const [attempt] = e?.attempts ?? []
    assert.ok(e && attempt)
    e.attempts.push({
      ...attempt,
      id: `${attempt.id}-2`,
      n: 2,
      error: { kind: 'assertion', message: 'writes greet.js: expected it to exist' },
    })
    assert.equal(evalOf(suiteResult(record), 'writes greet.js')?.outcome, 'fail')
  })

  test('an error outside any attempt fails the outcome, is listed and leads the tally', () => {
    const record = read(raw)
    assert.equal(suiteResult(record).errors.length, 0)
    record.errors = ['evals/a.eval.ts: Cannot find module ./missing.ts']
    const s = suiteResult(record)
    assert.equal(s.outcome, 'fail')
    assert.deepEqual(s.errors, record.errors)
    assert.equal(s.tally.errors, 1)
    const lines = render(s, null, { color: false, verbose: false })
    assert.equal(lines[0], 'error: evals/a.eval.ts: Cannot find module ./missing.ts')
    assert.match(lines.at(-1) ?? '', /^1 run error · \d+ fail · /)
  })

  const family = 'greets %s in the house style'

  test("a family's first case with no counted attempt lists the checks its other cases ran", () => {
    const record = read(raw)
    const [first] = record.evals.filter((e) => e.family?.id.endsWith(family) && e.family.case === 0)
    assert.ok(first)
    for (const a of first.attempts) {
      Object.assign(a, { outcome: 'infra_error', assertions: [] })
      a.error = { kind: 'infra', message: 'Docker is not running' }
    }
    for (const c of first.cells) {
      delete c.checks
      Object.assign(c, { pass: 0, fail: 0, infraError: c.runs, outcome: 'infra_error' })
    }
    const k = evalOf(suiteResult(record), family)?.cases?.[0]
    assert.equal(k?.label, 'Ada')
    for (const cell of k?.cells ?? []) {
      assert.deepEqual(
        cell.checks.map((x) => [x.label, x.outcome.status]),
        [['house greeting', 'not run']],
        cell.key,
      )
    }
  })

  test("a family's pooled arm and columns come from any case, not only the first", () => {
    const record = read(raw)
    const [first] = record.evals.filter((e) => e.family?.id.endsWith(family) && e.family.case === 0)
    assert.ok(first)
    const variant = 'fake/with-skill/fake'
    first.cells = first.cells.filter((c) => c.key !== variant)
    first.attempts = first.attempts.filter((a) => a.cell !== variant)
    const s = suiteResult(record)
    const e = evalOf(s, family)
    assert.deepEqual(
      e?.pooled?.map((p) => p.path.split('/').at(-1)),
      ['fake+with-skill+fake'],
      'the pooled path names the cell, read from a later case',
    )
    const block =
      text(s)
        .split('\n\n')
        .find((b) => b.includes(family)) ?? ''
    assert.match(
      block,
      /^ {4}with-skill +3 of 3 {2}can't tell yet$/m,
      'the pooled row has the variant',
    )
  })

  test("a family's questions are every case's, summed over the cases that answered them", () => {
    const answers = entries.find((x) => x.name === 'with-answers')
    const asked = read(answers?.runs[0]?.raw as Record<string, unknown>).evals.find(
      (x) => x.name === 'writes a greeting',
    )?.answers
    assert.ok(asked?.length)
    const record = read(raw)
    const cases = record.evals.filter((e) => e.family?.id.endsWith(family))
    for (const c of cases.filter((x) => (x.family?.case ?? 0) >= 2)) c.answers = asked
    const [question] = evalOf(suiteResult(record), family)?.questions ?? []
    const [one] = asked
    assert.ok(question && one)
    assert.equal(question.question, one.question, 'the first case asked nothing')
    assert.equal(question.votes, one.votes.length * 2)
    assert.deepEqual(
      question.rates,
      one.rates.map((r) => ({ cut: r.cut, name: r.name, wins: r.wins * 2, n: r.n * 2 })),
    )
  })
})

describe('messageLine', () => {
  test('keeps a one-line message', () => {
    assert.equal(messageLine('sandbox died'), 'sandbox died')
  })
  test('joins a first line ending in a colon with the next, without its log prefix', () => {
    assert.equal(
      messageLine('Building the image failed:\n    | E: Unable to locate package jqq\n    | more'),
      'Building the image failed: E: Unable to locate package jqq',
    )
  })
  test('skips lines with no letter or digit', () => {
    assert.equal(messageLine('\n  ---\n:\nDocker is not running\nrest'), 'Docker is not running')
  })
  test('keeps a lone colon-ended line when nothing follows', () => {
    assert.equal(messageLine('Docker failed:'), 'Docker failed:')
  })
})

describe('reeval run --json', () => {
  test('prints the suite result as the only stdout, and the progress on stderr', async () => {
    const p = await project('suite-json', {
      'reeval.config.ts': fakeConfig({ harness: `{ files: { 'hello.txt': 'hi\\n' } }` }),
      'evals/hello.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
const plain = defineEnvironment('plain', {})
const bye = defineEnvironment('bye', { files: { 'bye.txt': 'bye' } })
evaluate('writes hello.txt', { compare: { baseline: plain, variants: [bye] } }, async (c) => {
  console.log('a log line from the eval')
  process.stdout.write('a direct write\\n')
  await c.send('write hello.txt')
  await expect(c.exec('test -f hello.txt'), 'hello.txt exists').toSucceed()
  await expect.require(c.exec('test -f bye.txt'), 'has bye.txt').toSucceed()
  await expect(c.exec('false'), 'fails after').toSucceed()
})
`,
    })
    const r = await runCli(p.dir, ['run', '--json', '--ui', 'plain'])
    assert.equal(r.code, 1, r.stderr)
    const s = JSON.parse(r.stdout) as SuiteResult
    assert.match(r.stderr, /writes hello\.txt/)
    assert.equal(s.outcome, 'fail')
    assert.deepEqual(s.tally, {
      errors: 0,
      pass: 0,
      notGated: 0,
      fail: 1,
      infraError: 0,
      canceled: 0,
      skipped: 0,
    })
    const e = s.files[0]?.evals[0]
    assert.equal(e?.across, 'change')
    const status = (environment: string) =>
      e?.cells
        ?.find((c) => c.environment === environment)
        ?.checks.map((k) => [k.label, k.outcome.status])
    assert.deepEqual(status('plain'), [
      ['hello.txt exists', 'ran'],
      ['has bye.txt', 'ran'],
      ['fails after', 'not run'],
    ])
    assert.deepEqual(status('bye'), [
      ['hello.txt exists', 'ran'],
      ['has bye.txt', 'ran'],
      ['fails after', 'ran'],
    ])
    const shown = await runCli(p.dir, ['show', '--json'])
    assert.equal(JSON.parse(shown.stdout).kind, 'reeval-run', 'reeval show --json is the record')
  })

  test('with --dry-run still prints the plan', async () => {
    const p = await project('suite-json-plan', {
      'reeval.config.ts': fakeConfig(),
      'evals/hello.eval.ts': `import { evaluate } from 'reeval'
evaluate('plans', async (c) => { await c.send('hi') })
`,
    })
    const r = await runCli(p.dir, ['run', '--dry-run', '--json'])
    assert.equal(r.code, 0, r.stderr)
    const plan = JSON.parse(r.stdout)
    assert.equal(plan.totals.attempts, 1)
    assert.equal(plan.evals.length, 1)
  })
})
