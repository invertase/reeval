import { evaluate, expect } from 'reeval'
import { marked, plain } from './env.ts'

// The control has no marker, so its hard expect ends the body: `reached` doesn't run there, and
// its cell reads `not run`, never `0 of 1`.
evaluate('lands', { compare: { baseline: plain, variants: [marked] } }, async (c) => {
  await expect(c, 'has the marker').toHaveFile('marker.txt')
  expect(c.attempt.cell.role, 'reached').toBe('variant')
})
