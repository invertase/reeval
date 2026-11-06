import { evaluate, expect } from 'reeval'

// Must fail: its failure reaches the stream, and the run's exit 1 is attach's.
evaluate('canary', async (c) => {
  expect(c.attempt.n, 'second try').toBe(2)
})
