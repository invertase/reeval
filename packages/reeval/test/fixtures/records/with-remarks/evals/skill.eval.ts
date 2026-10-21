import { evaluate, expect } from 'reeval'
import { docs, marked } from './env.ts'

// too-few-tries: two tries a side, and the variant wins every one.
evaluate('skill helps', { runs: 2, compare: { baseline: docs, variants: [marked] } }, async (c) => {
  await c.send('look it up')
  await c.send('and again')
  expect.soft(c.attempt.cell.role, 'uses the marker').toBe('variant')
})
