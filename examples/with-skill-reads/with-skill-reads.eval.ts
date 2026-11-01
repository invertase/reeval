import { defineEnvironment, evaluate, expect } from 'reeval'

const withJsdoc = defineEnvironment('jsdoc', ({ directory, skill }) => ({
  files: directory('./project'),
  skills: [skill.local('./skills/jsdoc')],
}))

evaluate('documents the new function', { environments: withJsdoc }, async (c) => {
  await c.send('Add a multiply(a, b) function to src/math.js.')

  await expect(c, 'JSDoc block').toHaveFile('src/math.js', /\*\/\s*export function multiply/)
})
