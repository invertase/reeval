import { evaluate, expect } from 'reeval'
import { marked, plain } from './env.ts'

// The control has no marker, so its failed `expect.require` ends the body: `reached` doesn't run
// there, and its cell reads `not run`, never `0 of 1`.
evaluate('lands', { compare: { control: plain, variants: [marked] } }, async (c) => {
  await expect.require(c, 'has the marker').toHaveFile('marker.txt')
  expect(c.attempt.cell.role, 'reached').toBe('variant')
})
