import { evaluate, expect } from 'reeval'
evaluate('lands heads on the first try', { runs: 3 }, async (c) => {
  await c.send('flip the coin')
  expect.soft(c.attempt.n, 'lands heads').toBe(1)
})
