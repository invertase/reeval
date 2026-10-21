import { evaluate, expect } from 'reeval'

// Must fail: the one fail the tally counts.
evaluate('canary', async (c) => {
  expect(c.attempt.n, 'second try').toBe(2)
})
