import { defineEnvironment, evaluate, expect } from 'reeval'

const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))
const withJsdoc = math.extendEnvironment('jsdoc', ({ skill }) => ({
  skills: [skill.local('./skills/jsdoc')],
}))

// The compare's lift is paired by case across all six cases, so one run a side gives a verdict.
// minLift gates that pooled lift, not each case's.
const functions = ['subtract', 'multiply', 'divide', 'power', 'max', 'min']

evaluate(
  'documents a function',
  { cases: functions, compare: { control: math, variants: [withJsdoc], minLift: 0.2 } },
  async (c, name) => {
    await c.send(`Add a ${name}(a, b) function to src/math.js.`)

    const documented = new RegExp(`\\*/\\s*export function ${name}\\b`)
    await expect(c, 'JSDoc block').toHaveFile('src/math.js', documented)
  },
)
