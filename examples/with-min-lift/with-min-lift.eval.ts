import { defineEnvironment, evaluate, expect, group } from 'reeval'

const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))
const withJsdoc = math.extendEnvironment('jsdoc', ({ skill }) => ({
  skills: [skill.local('./skills/jsdoc')],
}))

group(
  'jsdoc skill',
  // minLift: 0 fails a variant unless it's confidently better than the control. Four tries a
  // side is the fewest that can show that.
  { compare: { baseline: math, variants: [withJsdoc], minLift: 0 }, runs: 4 },
  () => {
    evaluate('documents the new function', async (c) => {
      await c.send('Add a multiply(a, b) function to src/math.js.')
      await expect(c, 'JSDoc block').toHaveFile('src/math.js', /\*\/\s*export function multiply/)
    })

    evaluate('keeps the tests green', async (c) => {
      await c.send('Add a multiply(a, b) function to src/math.js.')
      await expect(c.exec('node --test')).toSucceed()
    })
  },
)
