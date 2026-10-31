import { evaluate, expect } from 'reeval'
import { marked, plain } from './env.ts'

// Must fail: the same misses with `gate: 'all'` gate the eval.
evaluate('canary', { compare: { control: plain, variants: [marked], gate: 'all' } }, async (c) => {
  await expect(c, 'has the marker').toHaveFile('marker.txt', /nope/)
})
