import { defineEnvironment, evaluate, expect } from 'reeval'

// The control is the small package in ./project; the variant adds the changelog skill.
const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))
const withSkill = math.extendEnvironment('changelog', ({ skill }) => ({
  skills: [skill.local('./skills/changelog')],
}))

evaluate(
  'records the change in the changelog',
  { compare: { baseline: math, variants: [withSkill] }, runs: 2 },
  async (c) => {
    await c.send('Add a multiply(a, b) function to src/math.js.')

    await expect.soft(c.exec('node --test'), 'tests pass').toSucceed()
    await expect(c, 'changelog entry').toHaveFile('CHANGELOG.md', /## Unreleased\s+- feat: /)
  },
)
