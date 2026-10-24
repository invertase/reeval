import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from ./project, whose median() sorts numbers as strings.
const stats = defineEnvironment('stats', ({ directory }) => ({ files: directory('./project') }))

evaluate('fixes the bug without touching the tests', { environment: stats }, async (c) => {
  await c.send('npm test fails. Find the bug in src/ and fix it.')

  await expect(c.exec('npm test')).toSucceed()
  expect(c, 'tests unchanged').not.toHaveChanged(['test/**'])
})
