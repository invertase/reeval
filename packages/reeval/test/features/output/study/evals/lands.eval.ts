import { evaluate, expect } from 'reeval'
import { marked, plain } from './env.ts'

// A study: nothing gates it, so its misses in both arms leave it `not gated`, never `pass`.
evaluate('lands', { compare: { baseline: plain, variants: [marked], gate: 'none' } }, async (c) => {
  await expect(c, 'has the marker').toHaveFile('marker.txt', /nope/)
})
