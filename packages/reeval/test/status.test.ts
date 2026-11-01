import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeConfig, project, runCli } from './helpers.ts'

const EVALS = `import { defineEnvironment, evaluate, expect } from 'reeval'
const plain = defineEnvironment('plain', {})
const marked = defineEnvironment('marked', { files: { 'marker.txt': 'ok\\n' } })

evaluate('passes', async (c) => {
  await c.send('go')
  expect(1, 'one').toBe(1)
})

evaluate('two checks fail', { runs: 2, gate: { passRate: 0.5 } }, async (c) => {
  await c.send('go')
  if (c.attempt.n === 1) expect(1, 'first check').toBe(2)
  else expect('a', 'second check').toBe('b')
})

evaluate('throws', async (c) => {
  await c.send('go')
  throw new Error('the fixture is missing')
})

evaluate('compares', { runs: 1, compare: { baseline: plain, variants: [marked] } }, async (c) => {
  await c.send('go')
  expect(c.attempt.cell.role === 'variant', 'uses the marker').toBe(true)
})

evaluate.each([{ id: 'red' }, { id: 'green' }, { id: 'blue' }])('colors $id', async (c, { id }) => {
  await c.send('go')
  expect(id, 'is green').toBe('green')
})
`

/** From the file heading to the tally, with the run's time masked. */
const listOf = (stdout: string) => {
  const start = stdout.indexOf('evals/s.eval.ts\n')
  const end = stdout.indexOf('\nBrowse it:')
  assert.ok(start >= 0 && end > start, stdout)
  return stdout.slice(start, end).replace(/^Done in \S+/m, 'Done in <time>')
}

const PLAIN = `evals/s.eval.ts
├─ ✓ passes           1 of 1 run passed
├─ ✗ two checks fail  0 of 2 runs passed
│    Failed on fake every time.
│    2 checks failed:
│      "first check" failed once
│        expected 1 to be 2 // Object.is equality
│        at evals/s.eval.ts:12
│      "second check" failed once
│        expected 'a' to be 'b' // Object.is equality
│        at evals/s.eval.ts:13
├─ ✗ throws           0 of 1 run passed
│    Failed on fake.
│    1 run failed:
│      the fixture is missing
├─ ✓ compares         1 of 1 run passed
│    Baseline plain passed 0 of 1.
│    Variants, by pass rate:
│      marked  1 of 1  helped
│    Every failure was the same check:
│      "uses the marker" failed once, on the baseline
│        expected false to be true // Object.is equality
│        at evals/s.eval.ts:23
│    Worth knowing:
│      The marked variant passed 1 of 1 run and the baseline 0 of 1: better by 100 points, but on too few runs for the difference to hold. Fix at evals/s.eval.ts:21: set runs: 4, where a difference this size would hold.
└─ ✗ colors $id       1 of 3 runs passed
     Passed 1 of 3 on fake.
     Failed cases: red, blue.
     Every failure was the same check:
       "is green" failed 2 times
         expected 'red' to be 'green' // Object.is equality
         at evals/s.eval.ts:28

Done in <time> · 4 failed · 3 passed`

test('the status list: one line a pass, and a sentence for each way an eval went', async () => {
  const p = await project('status-list', {
    'reeval.config.ts': fakeConfig(),
    'evals/s.eval.ts': EVALS,
  })
  const plain = await runCli(p.dir, ['run', '--ui', 'plain'])
  assert.equal(plain.code, 1, plain.stdout + plain.stderr)
  assert.equal(listOf(plain.stdout), PLAIN)
  // An agent reads the same sentences, without the tree's glyphs.
  const agent = await runCli(p.dir, ['run', '--ui', 'agent'])
  assert.equal(agent.code, 1, agent.stdout + agent.stderr)
  assert.equal(
    listOf(agent.stdout),
    PLAIN.replace(/^[├└]─ /gm, '  ').replace(/^[│ ] {4}/gm, '    '),
  )
})
