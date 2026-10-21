import { evaluate, expect } from 'reeval'

// One cell that passes prints its verdict and name, nothing under it.
evaluate('lands', async (c) => {
  expect(c.attempt.n, 'first try').toBe(1)
})
