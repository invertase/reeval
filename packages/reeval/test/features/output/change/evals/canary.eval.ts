import { evaluate, expect } from 'reeval'
import { marked, plain } from './env.ts'

// Must fail: the marker says ok, not nope, so the variant fails too.
evaluate('canary', { compare: { baseline: plain, variants: [marked] } }, async (c) => {
  await expect(c, 'has the marker').toHaveFile('marker.txt', /nope/)
})
