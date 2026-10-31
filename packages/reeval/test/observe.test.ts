// `c.observe(name, value)`: the values it keeps, what it refuses, and how they're tallied and
// queried. The fixture `history/observe` checks the same from inside an attempt.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { observer } from '../src/attempt/observe.ts'
import type { Attempt } from '../src/attempt/state.ts'
import type { EvalRecord } from '../src/types.ts'
import { observedLine, observedTallies } from '../src/view/observations.ts'
import { fakeConfig, project, readRun, runCli } from './helpers.ts'

function attempt(ended = false, signal = new AbortController().signal) {
  const a = { record: {} as EvalRecord, turns: [] as unknown[], ended, signal }
  return { a, observe: observer(a as unknown as Attempt) }
}

describe('c.observe', () => {
  test('keeps the last value per name, in first-call order, with its turn', () => {
    const { a, observe } = attempt()
    observe('orm', 'none')
    a.turns.push({})
    observe('deps', ['pg'])
    observe('orm', 'drizzle')
    assert.deepEqual(a.record.observations, [
      { name: 'orm', value: 'drizzle', turn: 1 },
      { name: 'deps', value: ['pg'], turn: 1 },
    ])
  })

  test('masks a secret-looking value', () => {
    const { a, observe } = attempt()
    observe('env', { token: `ghp_${'a'.repeat(36)}` })
    assert.deepEqual(a.record.observations?.[0]?.value, { token: '[REDACTED]' })
  })

  test('refuses what it cannot record, naming why', () => {
    const { observe } = attempt()
    const refused: Array<[string, unknown, RegExp]> = [
      ['has space', 1, /needs a name of 1 to 64 letters/],
      ['n', Number.NaN, /takes JSON: NaN isn't a finite number/],
      ['n', { a: [1, undefined] }, /takes JSON: a undefined at a\[1\] isn't JSON/],
      ['n', new Date(0), /takes JSON: a Date isn't plain JSON/],
      ['n', 'x'.repeat(5000), /takes at most 4096 bytes of JSON \(got 5002\)/],
    ]
    for (const [name, value, message] of refused) {
      assert.throws(() => observe(name, value as never), message)
    }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    assert.throws(() => observe('n', cyclic as never), /refers to itself at self/)
    // biome-ignore lint/suspicious/noSparseArray: a hole is what's refused
    assert.throws(() => observe('n', [, 1] as never), /a undefined at \[0\] isn't JSON/)
    let deep: unknown = 1
    for (let i = 0; i < 100_000; i++) deep = [deep]
    assert.throws(() => observe('n', deep as never), /takes JSON: it nests deeper than 64 levels/)
  })

  test('refuses a call once the attempt timed out or was canceled', () => {
    const { a, observe } = attempt(false, AbortSignal.abort())
    assert.throws(() => observe('late', 1), /came after the attempt timed out or was canceled/)
    assert.equal(a.record.observations, undefined)
  })

  test('caps the names an attempt observes, and refuses a call after the body', () => {
    const { observe } = attempt()
    for (let i = 0; i < 50; i++) observe(`n${i}`, i)
    observe('n0', 'again')
    assert.throws(() => observe('n50', 1), /one name too many: an attempt observes at most 50/)
    assert.throws(() => attempt(true).observe('late', 1), /came after the eval's body returned/)
  })
})

describe('observed tallies', () => {
  const at = (cell: string, observations: Array<[string, unknown]>) => ({
    cell,
    observations: observations.map(([name, value]) => ({ name, value: value as never, turn: 1 })),
  })

  test('tally per name and cell: scalars, array items once each, numbers summarized', () => {
    const tallies = observedTallies([
      at('a', [
        ['orm', 'drizzle'],
        ['deps', ['pg', 'pg', 'drizzle-orm']],
        ['n', 4],
      ]),
      at('a', [
        ['orm', 'prisma'],
        ['n', 10],
        ['cfg', { strict: true }],
      ]),
      at('a', [
        ['orm', 'drizzle'],
        ['n', 1],
      ]),
      at('b', [['orm', 'prisma']]),
    ])
    assert.deepEqual(
      tallies.map((t) => [t.name, t.cell, observedLine(t)]),
      [
        ['orm', 'a', 'drizzle 2 · prisma 1'],
        ['orm', 'b', 'prisma 1'],
        ['deps', 'a', 'pg 1 · drizzle-orm 1 · 1 attempt'],
        ['n', 'a', 'median 4 · range 1–10 · 3 attempts'],
        ['cfg', 'a', '1 value in reeval query attempt_values · 1 attempt'],
      ],
    )
  })

  test('shows a value on one line', () => {
    const [t] = observedTallies([at('a', [['v', 'one\ntwo \u001b[31mred\u0007']])])
    assert.equal(t && observedLine(t), 'one two [31mred 1')
  })

  test('shows the top five, then how many more', () => {
    const [t] = observedTallies(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((v) => at('a', [['pick', v]])),
    )
    assert.equal(t && observedLine(t), 'a 1 · b 1 · c 1 · d 1 · e 1 · +2 more')
  })
})

describe('observations in a run', () => {
  test('recorded per attempt, tallied in the output and queryable, and never gating', async () => {
    const p = await project('observe-run', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('picks', { runs: 2 }, async (c) => {
  await c.send('x')
  c.observe('orm', c.attempt.n === 1 ? 'drizzle' : 'prisma')
  c.observe('files', c.attempt.n)
  expect(c.attempt.n, 'first run only').toBe(1)
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /observed +orm +drizzle 1 · prisma 1\n +files +median 1\.5 · range 1–2 · 2 attempts/,
    )
    const { run } = readRun(p.dir)
    const attempts = run.evals[0]?.attempts ?? []
    assert.deepEqual(
      attempts.map((a) => [a.outcome, a.observations?.map((o) => o.value)]),
      [
        ['pass', ['drizzle', 1]],
        ['fail', ['prisma', 2]],
      ],
    )
    const q = await runCli(p.dir, [
      'query',
      'SELECT attempt_id, outcome, name, kind, num, text, harness FROM attempt_values ORDER BY attempt_id, name',
      '--json',
    ])
    assert.equal(q.code, 0, q.stderr)
    assert.deepEqual(JSON.parse(q.stdout), [
      {
        attempt_id: 'fake/fake/fake#1',
        outcome: 'pass',
        name: 'files',
        kind: 'number',
        num: 1,
        text: null,
        harness: 'fake',
      },
      {
        attempt_id: 'fake/fake/fake#1',
        outcome: 'pass',
        name: 'orm',
        kind: 'string',
        num: null,
        text: 'drizzle',
        harness: 'fake',
      },
      {
        attempt_id: 'fake/fake/fake#2',
        outcome: 'fail',
        name: 'files',
        kind: 'number',
        num: 2,
        text: null,
        harness: 'fake',
      },
      {
        attempt_id: 'fake/fake/fake#2',
        outcome: 'fail',
        name: 'orm',
        kind: 'string',
        num: null,
        text: 'prisma',
        harness: 'fake',
      },
    ])
  })
})
