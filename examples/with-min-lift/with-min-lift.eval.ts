import { defineEnvironment, evaluate, expect } from 'reeval'

const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))
const withJsdoc = math.extendEnvironment('jsdoc', ({ skill }) => ({
  skills: [skill.local('./skills/jsdoc')],
}))

evaluate(
  'documents the new function',
  {
    // minLift: 0.2 fails the variant unless its lift's 95% interval starts above +20 points.
    // Four tries a side is the fewest that can show that.
    compare: { baseline: math, variants: [withJsdoc], minLift: 0.2 },
    runs: 4,
    gate: { passRate: 0.75 },
  },
  async (c) => {
    await c.send('Add a multiply(a, b) function to src/math.js.')
    await expect(c, 'JSDoc block').toHaveFile('src/math.js', /\*\/\s*export function multiply/)
  },
)
