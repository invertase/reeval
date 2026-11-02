import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from the small package in ./project.
const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

// No runs here, so each profile sizes it: the config's 2, pr's limit of 1, nightly's 4.
evaluate('adds a tested multiply function', { environments: math }, async (c) => {
  await c.send('Add a multiply(a, b) function to src/math.js, with a test in test/math.test.js.')

  await expect(c, 'exports multiply').toHaveFile('src/math.js', /export function multiply/)
  await expect(c.exec('node --test'), 'tests pass').toSucceed()
})
