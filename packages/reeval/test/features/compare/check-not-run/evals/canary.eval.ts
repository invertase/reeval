import { evaluate, expect } from 'reeval'
import { marked, plain } from './env.ts'

evaluate('canary', { compare: { baseline: plain, variants: [marked] } }, async (c) => {
  await c.sandbox()
  // The mistake: the marker says ok, not nope, so the variant fails here too.
  await expect(c, 'has the marker').toHaveFile('marker.txt', /nope/)
  expect(c.attempt.cell.role, 'reached').toBe('variant')
})
