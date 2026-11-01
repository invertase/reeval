import { defineEnvironment, evaluate, expect } from 'reeval'

// The control is the small package in ./project; the variant adds the changelog skill.
const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))
const withSkill = math.extendEnvironment('changelog', ({ skill }) => ({
  skills: [skill.local('./skills/changelog')],
}))

evaluate(
  'records the change in the changelog',
  // Four tries a side is the fewest that gives a verdict; the variant passes on 3 of 4 or more.
  { compare: { control: math, variants: [withSkill] }, runs: 4, gate: { passRate: 0.75 } },
  async (c) => {
    await c.send('Add a multiply(a, b) function to src/math.js.')

    await expect(c.exec('node --test'), 'tests pass').toSucceed()
    await expect(c, 'changelog entry').toHaveFile('CHANGELOG.md', /## Unreleased\s+- feat: /)
  },
)
