import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from the small package in ./project.
const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

// Set on the eval, so Jev judges it whichever profile runs: an eval's judge wins over a
// profile's. The version is pinned, since a new one can score the same work differently.
const jev = { model: 'typesafe-ai/jev-1.14.0' }

evaluate('writes a README for the package', { environment: math, judge: jev }, async (c) => {
  await c.send('Write a README.md for this package: what it is and how to call add.')

  await expect(c).toHaveFile('README.md', /add\(/)
  const verdict = await c.judge('Could a new user call add correctly from README.md alone?', {
    contents: ['README.md', 'src/math.js'],
  })
  expect(verdict).toPass()
})
