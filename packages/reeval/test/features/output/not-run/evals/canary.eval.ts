import { evaluate, expect } from 'reeval'
import { marked, plain } from './env.ts'

// Must fail: `reached` runs in the gated control and fails there, so its cell reads `0 of 1`.
evaluate('canary', { compare: { baseline: plain, variants: [marked], gate: 'all' } }, async (c) => {
  await expect.soft(c, 'has the marker').toHaveFile('marker.txt')
  expect(c.attempt.cell.role, 'reached').toBe('variant')
})
