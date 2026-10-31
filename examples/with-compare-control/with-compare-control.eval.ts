import { defineEnvironment, evaluate, expect } from 'reeval'

const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))
const withTesting = math.extendEnvironment('testing', ({ skill }) => ({
  skills: [skill.local('./skills/testing')],
}))

evaluate(
  'tests the new function',
  { compare: { control: math, variants: [withTesting] } },
  async (c) => {
    await c.send('Add a multiply(a, b) function to src/math.js.')

    await expect(c.exec('node --test'), 'tests pass').toSucceed()
    await expect(c, 'multiply has a test').toHaveFile('test/math.test.js', /multiply\(/)
  },
)
