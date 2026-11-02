import { evaluate, expect } from 'reeval'
import { marked, plain } from './env.ts'

evaluate('canary', { compare: { control: plain, variants: [marked] } }, async (c) => {
  // The mistake: the marker says ok, not nope, so the variant fails here too.
  await expect.require(c, 'has the marker').toHaveFile('marker.txt', /nope/)
  expect(c.attempt.cell.role, 'reached').toBe('variant')
})
