import { readFileSync } from 'node:fs'
import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// The agent starts from the small package in ./project.
const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

// A fake agent that always does the task right: if it fails, the eval is broken, not the agents.
const oracle = fakeHarness({
  id: 'oracle',
  files: { 'src/math.js': readFileSync(new URL('./oracle/src/math.js', import.meta.url), 'utf8') },
})

evaluate(
  'adds multiply, with an oracle beside the agents',
  { environments: math, harnesses: { add: oracle } },
  async (c) => {
    await c.send('Add a multiply(a, b) function to src/math.js.')

    await expect(c).toHaveFile('src/math.js', /export function multiply/)
    await expect(c.exec('node --test')).toSucceed()
  },
)

evaluate(
  'adds subtract, without the careful agent',
  {
    environments: math,
    harnesses: (inherited) => inherited.filter((h) => h.id !== 'fake-careful'),
  },
  async (c) => {
    await c.send('Add a subtract(a, b) function to src/math.js.')

    await expect(c).toHaveFile('src/math.js', /export function subtract/)
  },
)
