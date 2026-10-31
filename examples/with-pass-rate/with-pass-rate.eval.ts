import { defineEnvironment, evaluate, expect } from 'reeval'

const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

evaluate(
  'adds a tested multiply function',
  // Five tries, passing when three or more pass: the default gate would need all five.
  { environments: math, runs: 5, gate: { passRate: 0.6 } },
  async (c) => {
    await c.send('Add a multiply(a, b) function to src/math.js, with a test in test/math.test.js.')

    await expect(c, 'multiply added').toHaveFile('src/math.js', /export function multiply/)
    await expect(c.exec('node --test'), 'tests pass').toSucceed()
  },
)
