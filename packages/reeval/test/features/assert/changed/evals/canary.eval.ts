import { evaluate, expect } from 'reeval'
import { seeded } from './env.ts'

evaluate('canary', { environments: seeded }, async (c) => {
  await c.send('update the greet test')
  // The agent's shell command did change the test.
  expect(c).not.toHaveChanged('test/**')
})
