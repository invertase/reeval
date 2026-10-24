import { defineEnvironment, evaluate, expect } from 'reeval'

const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))
const withTesting = math.extendEnvironment('testing', ({ skill }) => ({
  skills: [skill.local('./skills/testing')],
}))

evaluate(
  'tests the new function',
  // No baseline: the eval's own environment, math, is the control.
  { environment: math, compare: { variants: [withTesting] } },
  async (c) => {
    await c.send('Add a multiply(a, b) function to src/math.js.')

    await expect.soft(c.exec('node --test'), 'tests pass').toSucceed()
    await expect(c, 'multiply has a test').toHaveFile('test/math.test.js', /multiply\(/)
  },
)
