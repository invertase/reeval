import { evaluate, expect } from 'reeval'
import { marked, plain } from './env.ts'

// The mistake: the baseline and the variant are swapped, so the variant has no marker.
evaluate('canary', { compare: { baseline: marked, variants: [plain] } }, async (c) => {
  await c.send('look for the marker')
  await expect(c, 'has the marker').toHaveFile('marker.txt')
})
