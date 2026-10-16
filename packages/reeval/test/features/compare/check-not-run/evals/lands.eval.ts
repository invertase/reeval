import { evaluate, expect } from 'reeval'
import { marked, plain } from './env.ts'

// The control has no marker, so its hard expect ends the body: `reached` is not run there, and
// the variant's tally counts it against the control.
evaluate('lands', { compare: { baseline: plain, variants: [marked] } }, async (c) => {
  await c.sandbox()
  await expect(c, 'has the marker').toHaveFile('marker.txt')
  expect(c.attempt.cell.role, 'reached').toBe('variant')
})
