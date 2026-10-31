import { evaluate, expect } from 'reeval'
import { docs } from './env.ts'

// flaky-check: only the first try of each run passes the check.
evaluate('coin', { runs: 3, environments: docs }, async (c) => {
  await c.send('look it up')
  await c.send('and again')
  expect.soft(c.attempt.n, 'lands heads').toBe(1)
})
