import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { pkgRoot, runCli } from './helpers.ts'
import { EXAMPLES, exampleDirs, examples, SHARED } from './support/examples.ts'

test('every shared profile is in the table', async () => {
  const { profiles } = await import(join(examples, 'profiles.ts'))
  assert.deepEqual(Object.keys(profiles).sort(), Object.keys(SHARED).sort())
})

test('every with-* example is in the table', () => {
  assert.deepEqual(exampleDirs(), Object.keys(EXAMPLES).sort())
})

test('examples/README.md links every with-* example', () => {
  const index = readFileSync(join(examples, 'README.md'), 'utf8')
  const linked = [...index.matchAll(/\]\(\.\/(with-[\w-]+)\)/g)].map((m) => m[1] as string)
  assert.deepEqual([...linked].sort(), exampleDirs())
})

type Cell = { harness: string }

test('test/real-agents plans the nightly smoke and questions profiles', async () => {
  const dir = join(pkgRoot, 'test/real-agents')
  const plans = {
    smoke: ['run', '--dry-run', '--json', '--profile', 'smoke'],
    questions: [
      'run',
      '--dry-run',
      '--json',
      '--config',
      'reeval.analysis.config.ts',
      '--profile',
      'questions',
    ],
  }
  const cells: Record<string, string[]> = {}
  for (const [profile, args] of Object.entries(plans)) {
    const plan = await runCli(dir, args)
    assert.equal(plan.code, 0, `${args.join(' ')}\n${plan.stdout}${plan.stderr}`)
    const evals: { file: string; cells: Cell[] }[] = JSON.parse(plan.stdout).evals
    cells[profile] = evals.flatMap((e) => e.cells.map((c) => `${e.file} ${c.harness}`)).sort()
  }
  assert.deepEqual(cells, {
    smoke: [
      'evals/brokering.eval.ts cursor:composer-2.5',
      'evals/gemini.eval.ts cursor:composer-2.5',
    ],
    questions: [
      'evals/questions.eval.ts cursor:composer-2.5',
      'evals/questions.eval.ts cursor:composer-2.5',
      'evals/questions.eval.ts pi:gemini-3.8-flash',
      'evals/questions.eval.ts pi:gemini-3.8-flash',
    ],
  })
})
