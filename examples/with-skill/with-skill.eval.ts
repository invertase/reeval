import { defineEnvironment, evaluate, expect } from 'reeval'

// The small package in ./project, with the jsdoc skill placed where the agent reads skills.
const math = defineEnvironment('math', ({ directory, skill }) => ({
  files: directory('./project'),
  skills: [skill.local('./skills/jsdoc')],
}))

evaluate('documents a new function the way the skill says', { environment: math }, async (c) => {
  const turn = await c.send('Add a multiply(a, b) function to src/math.js.')

  expect(turn).toHaveCalledSkill('jsdoc')
  await expect(turn).toHaveFile('src/math.js', /@returns[^/]*\*\/\s*export function multiply/)
  await expect(c.exec('node --test')).toSucceed()
})
