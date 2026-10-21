import { evaluate, expect } from 'reeval'

// Must fail: its block names the failed check and its assertion.
evaluate('canary', async (c) => {
  expect(c.attempt.n, 'second try').toBe(2)
})
