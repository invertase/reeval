// An eval with `cases` is one entry in every record a reader sees: records from before it was
// (each case its own entry, beside `families`) fold into it when read, and a resume unfolds it
// back into the entries a run plans.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { caseEntries, foldCases, unfoldCases } from '../src/history/cases.ts'
import type { RunRecord } from '../src/history/types.ts'
import { readableRecord } from '../src/view/record.ts'
import { suiteResult } from '../src/view/suite.ts'
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

  test('an eval without cases is left as it is', () => {
    const r = read()
    const plain = { ...r, evals: r.evals.filter((e) => !e.cases) }
    assert.equal(foldCases(plain), plain)
    assert.equal(unfoldCases(plain), plain)
  })
})
