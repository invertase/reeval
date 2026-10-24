import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from ./project, where sum() skips the first item and its test fails.
const buggy = defineEnvironment('buggy-sum', ({ directory }) => ({ files: directory('./project') }))

evaluate('fixes sum without touching its test', { environment: buggy }, async (c) => {
  await c.send('npm test fails. Fix the bug in src/math.js.')

  expect(c).not.toHaveChanged(['test/**'])
  await expect(c.exec('node --test')).toSucceed()
})
