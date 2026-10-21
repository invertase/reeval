import { evaluate, expect } from 'reeval'

// Must fail: the one fail the tally counts beside the run error.
evaluate('canary', async (c) => {
  expect(c.attempt.n, 'second try').toBe(2)
})
