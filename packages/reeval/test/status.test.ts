import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { evalRow } from '../src/ui/status.ts'
import { suiteResult } from '../src/view/suite.ts'
import { fakeConfig, project, readRun, runCli } from './helpers.ts'
import { copyOut } from './support/examples.ts'

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

evaluate('compares', { runs: 1, compare: { control: plain, variants: [marked] } }, async (c) => {
  await c.send('go')
  expect(c.attempt.cell.role === 'variant', 'uses the marker').toBe(true)
})

evaluate('colors', { cases: [{ id: 'red' }, { id: 'green' }, { id: 'blue' }] }, async (c, { id }) => {
  await c.send('go')
  expect(id, 'is green').toBe('green')
})
`

/** From the file heading to the tally, with the run's time masked. */
const listOf = (stdout: string) => {
  const start = stdout.indexOf('evals/s.eval.ts\n')
  const end = stdout.indexOf('\nBrowse it:')
  assert.ok(start >= 0 && end > start, stdout)
  return stdout
    .slice(start, end)
    .replace(/^Done in \S+/m, 'Done in <time>')
    .replace(/Snapshot: \S+/g, 'Snapshot: <path>')
}

const PLAIN = `evals/s.eval.ts
├─ ✓ passes           1 of 1 run passed
├─ ✗ two checks fail  0 of 2 runs passed
│    Failed on fake every time.
│    ✗ first check   failed 1 of 1 run
│      expected 1 to be 2 // Object.is equality · evals/s.eval.ts:12
│    ✗ second check  failed 1 of 1 run
│      expected 'a' to be 'b' // Object.is equality · evals/s.eval.ts:13
├─ ✗ throws           0 of 1 run passed
│    Failed on fake.
│    ✗ 1 run failed
│      the fixture is missing
├─ ✓ compares         1 of 1 variant run passed
│    The marked variant helped.
│    arm              passed  verdict
│    plain (control)  0 of 1
│    marked           1 of 1  helped
│    ✗ uses the marker  failed on the control · expected
│      expected false to be true // Object.is equality · evals/s.eval.ts:23
│    Worth knowing: 1 run per side; set runs: 4 at evals/s.eval.ts:21 to confirm this difference.
└─ ✗ colors           1 of 3 runs passed
     Passed 1 of 3 on fake.
     Failed cases: red, blue.
     ✗ is green  failed 2 of 3 runs
       expected 'red' to be 'green' // Object.is equality · evals/s.eval.ts:28

Done in <time> · 4 failed · 3 passed`

test('the status list: one line a pass, and a sentence for each way an eval went', async () => {
  const p = await project('status-list', {
    'reeval.config.ts': fakeConfig({ harness: '{ turnMs: 1000 }' }),
    'evals/s.eval.ts': EVALS,
  })
  const plain = await runCli(p.dir, ['run', '--ui', 'plain'])
  assert.equal(plain.code, 1, plain.stdout + plain.stderr)
  assert.equal(listOf(plain.stdout), PLAIN)
  // An agent reads the same sentences without the tree's glyphs, with the detail -v adds to them:
  // each failure's snapshot and each remark's whole sentence.
  const agent = await runCli(p.dir, ['run', '--ui', 'agent'])
  assert.equal(agent.code, 1, agent.stdout + agent.stderr)
  const agentList = listOf(agent.stdout)
  assert.match(agentList, /^ {4}Snapshot: <path> \(\+1 more in summary\.md\)$/m)
  assert.match(agentList, /^ {4}Snapshot: <path>$/m)
  const remark = 'Worth knowing: 1 run per side; set runs: 4 at evals/s.eval.ts:21'
  const whole =
    'Worth knowing: The marked variant passed 1 of 1 run and the control 0 of 1: better by 100 points, but on too few runs for the difference to hold. Fix at evals/s.eval.ts:21: set runs: 4, where a difference this size would hold.'
  assert.ok(agentList.includes(`    ${whole}\n`), agentList)
  assert.equal(
    agentList
      .replace(/^ {4}Snapshot: .*\n/gm, '')
      .replace(whole, `${remark} to confirm this difference.`),
    PLAIN.replace(/^[├└]─ /gm, '  ').replace(/^[│ ] {4}/gm, '    '),
  )
})

const FASTER = `import { defineEnvironment, evaluate, expect } from 'reeval'
const plain = defineEnvironment('plain', {})
const marked = defineEnvironment('marked', {})

evaluate('compares', { runs: 4, compare: { control: plain, variants: [marked] } }, async (c) => {
  for (let i = 0; i < (c.attempt.cell.role === 'variant' ? 1 : 5); i++) await c.send('go')
  expect(1, 'one').toBe(1)
})
`

test('a compare whose effort holds prints its comparison, which every reader shares, and no tie remark', async () => {
  const p = await project('status-measures', {
    'reeval.config.ts': fakeConfig({ harness: '{ delayMs: 150 }' }),
    'evals/s.eval.ts': FASTER,
  })
  const run = await runCli(p.dir, ['run', '--ui', 'plain'])
  assert.equal(run.code, 0, run.stdout + run.stderr)
  const list = listOf(run.stdout)
  assert.match(
    list,
    /^ {5}arm {14}passed {2}verdict {2}vs control\n {5}plain \(control\) {2}4 of 4\n {5}marked {11}4 of 4 {2}same {5}[4-6](\.\d)?× faster$/m,
  )
  assert.doesNotMatch(list, /Worth knowing|can't tell them apart|looks different/)
  const rows = await runCli(p.dir, ['query', 'measure_effects', '--json'])
  assert.equal(rows.code, 0, rows.stderr)
  const effects = JSON.parse(rows.stdout) as Array<Record<string, unknown>>
  assert.deepEqual(
    effects.map((r) => [r.measure, r.verdict, r.variant, r.control]),
    [
      ['pass', 'same', 'marked', 'fake/plain/fake'],
      ['tools', 'same', 'marked', 'fake/plain/fake'],
      ['agentMs', 'better', 'marked', 'fake/plain/fake'],
      ['check', 'same', 'marked', 'fake/plain/fake'],
    ],
  )
  const again = await runCli(p.dir, ['run', '--ui', 'plain'])
  assert.equal(again.code, 0, again.stdout + again.stderr)
  const idOf = (stdout: string) => /Run: +(\S+)/.exec(stdout)?.[1] ?? ''
  const compare = await runCli(p.dir, ['compare', idOf(run.stdout), idOf(again.stdout), '-v'])
  assert.equal(compare.code, 0, compare.stdout + compare.stderr)
  assert.match(
    compare.stdout,
    /fake\/marked\/fake vs baseline +same pass rate · [4-6](\.\d)?× faster → same pass rate · [4-6](\.\d)?× faster/,
  )
})

const IDENTICAL = `import { defineEnvironment, evaluate, expect } from 'reeval'
const plain = defineEnvironment('plain', {})
const marked = defineEnvironment('marked', { files: { 'marker.txt': 'ok\\n' } })

evaluate('compares', { runs: 4, compare: { control: plain, variants: [marked] } }, async (c) => {
  await c.send('go')
  expect(1, 'one').toBe(1)
})
`

test('identical arms are a tie: make the task harder', async () => {
  const p = await project('status-identical', {
    'reeval.config.ts': fakeConfig({ harness: '{ turnMs: 1000 }' }),
    'evals/s.eval.ts': IDENTICAL,
  })
  const run = await runCli(p.dir, ['run', '--ui', 'plain'])
  assert.equal(run.code, 0, run.stdout + run.stderr)
  assert.match(
    listOf(run.stdout),
    /passed every run \(4 of 4 and 4 of 4\): the task can't tell them apart, since both always pass\. Fix at evals\/s\.eval\.ts:\d+: make the task harder, so the control can fail\./,
  )
  const attempts = readRun(p.dir).run.evals.flatMap((e) => e.attempts)
  assert.deepEqual(
    new Set(attempts.map((a) => a.timings.agentMs)),
    new Set([1000]),
    'turnMs is the agent time',
  )
})

test('with-compare-questions, whose question picked the variant 4 of 4, names the runs that would confirm it', async () => {
  const dir = await copyOut('with-compare-questions')
  const config = join(dir, 'reeval.config.ts')
  // Agent time stays the same, so the question is the only lean.
  writeFileSync(
    config,
    readFileSync(config, 'utf8').replace('fakeHarness({', 'fakeHarness({ turnMs: 1000,'),
  )
  const run = await runCli(dir, ['run', '--ui', 'plain', '-v'], { timeoutMs: 300_000 })
  assert.equal(run.code, 0, run.stdout + run.stderr)
  assert.match(
    run.stdout,
    /but the variant looks different: (.+ and )?"Which divide\(\) says more clearly what went wrong when b is…" picked the variant in 8 of 8 votes \(4 of 4 decisive pairs\); about \d+ runs a side would confirm it\./,
  )
  assert.match(run.stdout, / won 8 of 8$/m, 'the standings count the same votes')
  assert.doesNotMatch(run.stdout, /make the task harder/)
  const brief = await runCli(dir, ['run', '--ui', 'plain'], { timeoutMs: 300_000 })
  assert.match(
    brief.stdout,
    /^ {5}Worth knowing: Both passed every run, but the variant looks different; set runs: \d+ at with-compare-questions\.eval\.ts:\d+ to confirm it\.$/m,
    'without -v, the remark is one short line',
  )
})

test('with-effort at runs: 3, too few for a rank test, still names its speedup', async () => {
  const dir = await copyOut('with-effort')
  const file = join(dir, 'with-effort.eval.ts')
  writeFileSync(file, readFileSync(file, 'utf8').replace('runs: 4', 'runs: 3'))
  const run = await runCli(dir, ['run', '--ui', 'plain'], { timeoutMs: 300_000 })
  assert.equal(run.code, 0, run.stdout + run.stderr)
  assert.match(
    run.stdout,
    /^ {5}Worth knowing: 3 runs per side; set runs: \d+ at with-effort\.eval\.ts:\d+ to rule out a difference\. So far, \S+ (.+ and )?runs [\d.]+× faster\.$/m,
  )
  const verbose = await runCli(dir, ['run', '--ui', 'plain', '-v'], { timeoutMs: 300_000 })
  assert.match(verbose.stdout, /^ {5}\S+ +3 of 3 {2}same +(.+ · )?[\d.]+× faster \(leans\)/m)
  assert.doesNotMatch(verbose.stdout, /\blooks [\d.]+×/, 'a lean is marked after it, not before')
})

test("a compare's control line names the harnesses when they disagree, with or without variants", async () => {
  const p = await project('status-control-disagrees', {
    'reeval.config.ts': `import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
export default defineConfig({
  include: ['evals/*.eval.ts'],
  harnesses: [fakeHarness({ id: 'left' }), fakeHarness({ id: 'right' })],
  sandbox: fakeSandbox(),
})
`,
    'evals/c.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
const plain = defineEnvironment('plain', {})
const marked = defineEnvironment('marked', { files: { 'marker.txt': 'ok\\n' } })
evaluate('compares', { runs: 1, compare: { control: plain, variants: [marked] } }, async (c) => {
  await c.send('go')
  expect(c.attempt.cell.key.startsWith('left/'), 'on left').toBe(true)
})
`,
  })
  await runCli(p.dir, ['run', '--ui', 'plain'])
  const { run } = readRun(p.dir)
  const [e] = suiteResult(run).files.flatMap((f) => f.evals)
  assert.ok(e?.cells)
  const text = (row: { detail: { text: string }[] }) => row.detail.map((d) => d.text).join('\n')
  assert.match(
    text(evalRow(run, e, [])),
    /^plain \(control\) {2}1 of 2 \(left 1 of 1, right 0 of 1\)$/m,
  )
  const alone = { ...e, cells: e.cells.filter((c) => c.variant === null) }
  assert.match(
    text(evalRow(run, alone, [])),
    /^Control plain passed 1 of 2 \(left 1 of 1, right 0 of 1\)\.$/m,
  )
})

test('under -v a judged check reads as its judge score, marked (leans), not again as its pass rate', async () => {
  const p = await project('status-judged-lean', {
    'reeval.config.ts': fakeConfig(),
    'evals/c.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
const plain = defineEnvironment('plain', {})
const marked = defineEnvironment('marked', { files: { 'marker.txt': 'ok\\n' } })
evaluate('compares', { runs: 1, compare: { control: plain, variants: [marked] } }, async (c) => {
  await c.send('go')
  expect(c.attempt.cell.role === 'variant', 'tidy').toBe(true)
})
`,
  })
  await runCli(p.dir, ['run', '--ui', 'plain'])
  const { run } = readRun(p.dir)
  const [e] = suiteResult(run).files.flatMap((f) => f.evals)
  assert.ok(e?.cells)
  const lean = {
    variant: 1,
    control: 0,
    lo: null,
    hi: null,
    p: 0.3,
    verdict: 'leans',
    leaning: 'better',
    needed: 4,
    unit: 'runs',
    short: { now: 1, at: 4 },
  } as const
  const measures = [
    { ...lean, measure: 'judge', label: 'tidy', estimate: 0.97, text: 'judge "tidy" +0.97' },
    { ...lean, measure: 'check', label: 'tidy', estimate: 1, text: '"tidy" +100 pts' },
    { ...lean, measure: 'check', label: 'builds', estimate: 1, text: '"builds" +100 pts' },
  ]
  const cells = e.cells.map((c) => (c.variant ? { ...c, measures } : c))
  const row = evalRow(run, { ...e, cells, pooled: [] }, [], true)
  const variant = row.detail.map((d) => d.text).find((t) => t.startsWith('marked'))
  assert.match(
    variant ?? '',
    /helped +judge "tidy" \+0\.97 \(leans\) · "builds" \+100 pts \(leans\)$/,
  )
})
