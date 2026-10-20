// `suiteResult`, the facts view-model: every corpus run builds one, three of them against JSON
// goldens (test/fixtures/suite/), the effect table and not-run checks.
// REEVAL_UPDATE_SNAPSHOTS=1 rewrites the goldens; review the diff.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { biome } from '../scripts/schema/check.ts'
import type { CheckTally, RunRecord } from '../src/history/types.ts'
import { readableRecord } from '../src/view/record.ts'
import {
  checkEffect,
  EFFECT_MIN_COUNTED,
  type Effect,
  effectOf,
  factSegment,
  type SuiteResult,
  suiteResult,
} from '../src/view/suite.ts'
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
        assert.equal(new Set(s.paths).size, s.paths.length, 'every path is unique')
        const evals = s.files.flatMap((f) => f.evals)
        for (const e of evals) {
          assert.ok(s.paths.includes(e.path))
          assert.equal((e.cells === null) !== (e.cases === null), true, 'cells or cases, not both')
          assert.equal(e.family, e.cases !== null)
        }
        // A family case or an eval with no cases is one block; each eval in the record is one.
        const t = s.tally
        assert.equal(t.pass + t.fail + t.infraError + t.skipped, record.evals.length)
        assert.deepEqual(
          s.files.map((f) => f.path),
          [...s.files.map((f) => f.path)].sort(),
        )
        for (const c of cellsOf(s)) {
          assert.equal(c.attempts, c.passed + c.failed + c.infraError + c.skipped, c.path)
          assert.ok(s.paths.includes(c.path), c.path)
          for (const k of c.checks) assert.ok(s.paths.includes(k.path), k.path)
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

  test('effort is set only from 4 counted attempts', () => {
    const s = suiteResult(fourEach())
    const four = cellsOf(s).filter(
      (c) => c.harness === 'fake' && c.path.includes('greets in the house style'),
    )
    assert.ok(four.length)
    for (const c of four) {
      assert.notEqual(c.effort, null, c.path)
      assert.ok(s.paths.includes(`${c.path}/effort`), c.path)
    }
    const one = suiteResult(read(raw))
    assert.ok(cellsOf(one).every((c) => c.effort === null))
    assert.ok(!one.paths.some((p) => p.endsWith('/effort')))
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

