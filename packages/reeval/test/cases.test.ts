// An eval with `cases` is one entry in every record a reader sees: records from before it was
// (each case its own entry, beside `families`) fold into it when read, and a resume unfolds it
// back into the entries a run plans.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { caseEntries, foldCases, unfoldCases } from '../src/history/cases.ts'
import type { RunRecord } from '../src/history/types.ts'
import { readableRecord } from '../src/view/record.ts'
import { suiteResult } from '../src/view/suite.ts'
import { fakeConfig, project, recordedRuns, runCli } from './helpers.ts'
import { corpusEntries } from './support/corpus.ts'

const before = corpusEntries().find((e) => e.name === 'before-cases')
const raw = before?.runs[0]?.raw as unknown as RunRecord
const read = () => readableRecord(structuredClone(raw) as never)
const evalNamed = (r: RunRecord, name: string) => r.evals.find((e) => e.name === name)

describe('an eval with cases in a record from before it was one entry', () => {
  test('is one eval per declaration, its cases inside it, and the run counts it once', () => {
    assert.ok(raw, 'the before-cases corpus entry')
    assert.equal(raw.evals.length, 13, 'canary: the old record has an entry per case')
    const r = read()
    assert.deepEqual(
      r.evals.map((e) => [e.name, e.cases?.map((k) => k.key), e.caseCount]),
      [
        ['rated', ['a', 'b', 'c'], 3],
        ['strict', ['x', 'y'], 2],
        ['lands', ['next', 'vite'], 3],
        ['lifted', ['Ada', 'Grace', 'Linus'], 3],
        ['alone', ['only'], 1],
        ['picks', ['p1', 'p2'], 2],
      ],
    )
    assert.equal(r.summary.evals, 6)
    assert.equal(r.families, undefined)
    const s = suiteResult(r)
    assert.equal(s.files.flatMap((f) => f.evals).length, 6)
  })

  test("keeps each case's outcome, under the eval's pooled gate", () => {
    const r = read()
    const rated = evalNamed(r, 'rated')
    assert.equal(rated?.outcome, 'pass', 'its rate over the cases, 2 of 3, clears passRate 0.6')
    assert.deepEqual(
      rated?.cases?.map((k) => [k.key, k.outcome, k.verdict]),
      [
        ['a', 'pass', 'family'],
        ['b', 'pass', 'family'],
        ['c', 'fail', 'family'],
      ],
    )
    const [cell] = rated?.cells ?? []
    assert.deepEqual(
      [cell?.pass, cell?.fail, cell?.rate?.rate, cell?.rate?.outcome],
      [2, 1, 0.667, 'pass'],
    )
    const strict = evalNamed(r, 'strict')
    assert.equal(strict?.outcome, 'fail', "gate 'all': a failing case fails the eval")
    assert.deepEqual(
      strict?.cases?.map((k) => [k.key, k.outcome, k.verdict]),
      [
        ['x', 'pass', undefined],
        ['y', 'fail', undefined],
      ],
    )
  })

  test("keeps where's exclusions, the pooled lift and each attempt's case", () => {
    const r = read()
    const lands = evalNamed(r, 'lands')
    assert.ok(
      lands?.excluded?.some((x) => x.case === 'astro'),
      'a case left out everywhere',
    )
    assert.deepEqual(
      lands?.cases?.map((k) => [k.key, k.excluded?.map((x) => x.environment)]),
      [
        ['next', ['vite-app']],
        ['vite', ['next-app']],
      ],
    )
    const lifted = evalNamed(r, 'lifted')
    assert.equal(lifted?.outcome, 'fail', 'the pooled lift misses minLift 0.5')
    assert.deepEqual(
      lifted?.lifts?.map((l) => [l.pairs, l.minLift, l.outcome]),
      [[3, 0.5, 'fail']],
    )
    assert.ok(
      lifted?.cases?.every((k) => k.outcome === 'pass'),
      'each case passes on its own',
    )
    assert.deepEqual([...new Set(lifted?.attempts.map((a) => a.case))], ['Ada', 'Grace', 'Linus'])
    assert.ok(lifted?.attempts.every((a) => a.id === `${a.cell}#${a.case}#${a.n}`))
  })

  test('unfolds back into the entries the run planned, attempt keys and all', () => {
    const r = read()
    const back = unfoldCases(r)
    const keys = (x: RunRecord) => x.evals.flatMap((e) => e.attempts.map((a) => a.key)).sort()
    assert.deepEqual(keys(back), keys(raw))
    assert.deepEqual(back.evals.map((e) => e.id).sort(), raw.evals.map((e) => e.id).sort())
    const rated = back.families?.find((f) => f.name === 'rated')
    const old = raw.families?.find((f) => f.name === 'rated')
    assert.deepEqual(rated?.rates, old?.rates)
    assert.deepEqual(
      foldCases(back).evals.map((e) => e.id),
      r.evals.map((e) => e.id),
    )
    const [only] = caseEntries(evalNamed(r, 'alone') as never)
    assert.deepEqual(only?.family, {
      id: 'evals/cases.eval.ts › alone',
      name: 'alone',
      case: 0,
      cases: 1,
    })
  })

  test("a cell's fingerprint is over every case, so a change to any case changes it", () => {
    const r = read()
    const strict = evalNamed(r, 'strict')
    const [x, y] = strict?.cases ?? []
    assert.notEqual(
      x?.cells[0]?.fingerprintParts.sources,
      y?.cells[0]?.fingerprintParts.sources,
      'canary: each case has its own data',
    )
    const changed = structuredClone(raw)
    const member = changed.evals.find((e) => e.name === 'strict [y]')
    for (const c of member?.cells ?? []) {
      c.fingerprintParts.sources = 'changed'
      c.fingerprint = 'changed'
    }
    const after = evalNamed(readableRecord(changed as never), 'strict')
    assert.notEqual(after?.cells[0]?.fingerprint, strict?.cells[0]?.fingerprint)
    assert.notEqual(after?.fingerprint, strict?.fingerprint)
    assert.deepEqual(
      unfoldCases(r).evals.map((e) => e.fingerprint),
      raw.evals.map((e) => e.fingerprint),
    )
  })

  test('entries of an unpooled evaluate.each that share a bracketed name stay apart', () => {
    const old = structuredClone(raw)
    const lone = old.evals.find((e) => e.name === 'alone [only]') as RunRecord['evals'][number]
    const twin = { ...structuredClone(lone), name: 'alone [other]' }
    twin.id = twin.key = 'evals/cases.eval.ts › alone [other]'
    old.evals = [lone, twin]
    delete old.families
    const r = readableRecord(old as never)
    assert.deepEqual(
      r.evals.map((e) => [e.name, e.cases]),
      [
        ['alone [only]', undefined],
        ['alone [other]', undefined],
      ],
    )
  })

  test('an eval without cases is left as it is', () => {
    const r = read()
    const plain = { ...r, evals: r.evals.filter((e) => !e.cases) }
    assert.equal(foldCases(plain), plain)
    assert.equal(unfoldCases(plain), plain)
  })
})

describe('reeval compare of an eval with cases', () => {
  test('names a case that flipped under the rate that still gates the eval', async () => {
    const p = await project('compare-rated-case', {
      'reeval.config.ts': fakeConfig(),
      'evals/e.eval.ts': `import { evaluate, expect } from 'reeval'
const bad = process.env.BAD ?? ''
evaluate('rated', { cases: ['a', 'b', 'c', 'd', 'e'], gate: { passRate: 0.7 } }, async (c, k) => {
  await c.send(k)
  expect(k, 'ok').not.toBe(bad)
})
`,
    })
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    const head = await runCli(p.dir, ['run', '--record'], { env: { BAD: 'e' } })
    assert.equal(head.code, 0, head.stdout + head.stderr)
    const [a, b] = recordedRuns(p.dir)
    const cmp = await runCli(p.dir, ['compare', a ?? '', b ?? ''])
    assert.equal(cmp.code, 0, cmp.stdout + cmp.stderr)
    assert.match(cmp.stdout, /1 case now fails · 1 same$/m)
    assert.match(cmp.stdout, /^ {2}now fails +e$/m, 'the tally counts it, so a block names it')
  })
})

describe('reeval run prints an eval with cases', () => {
  test('the compact count says how many hidden cases failed, and a check names their runs', async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `q${i + 1}`)
    const p = await project('cases-compact-count', {
      'reeval.config.ts': fakeConfig(),
      'evals/e.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('bank', { cases: ${JSON.stringify(keys)}, runs: 2 }, async (c, k) => {
  await c.send(k)
  expect(Number(k.slice(1)) > 10, 'ok').toBe(true)
})
`,
    })
    const r = await runCli(p.dir, ['run', '--ui', 'plain'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /\+4 more cases: 2 failed, 2 passed \(-v\)$/m)
    assert.match(r.stdout, /ok {2}failed on q1 \(2 of 2 runs\), q2 \(2 of 2 runs\)/)
  })

  test('-v on a compare over cases prints the paired lift once, not a difference per case', async () => {
    const p = await project('cases-paired-stats', {
      'reeval.config.ts': fakeConfig(),
      'evals/e.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
const app = defineEnvironment('app', { env: { SKILL: '' } })
const skilled = app.extend('skilled', { env: { SKILL: 'yes' } })
evaluate(
  'writes',
  { cases: ['a', 'b', 'c', 'd', 'e', 'f'], compare: { control: app, variants: [skilled] } },
  async (c) => {
    await c.send('go')
    expect((await c.exec('printf %s "$SKILL"')).stdout, 'skill').toBe('yes')
  },
)
`,
    })
    const r = await runCli(p.dir, ['run', '--ui', 'plain', '-v'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(
      r.stdout.match(/paired over 6 cases, 95% interval [−+]\d+…[−+]\d+ points/g)?.length,
      1,
    )
    assert.doesNotMatch(r.stdout, /difference [−+]\d+ points/, 'no unpaired difference per case')
  })
})
