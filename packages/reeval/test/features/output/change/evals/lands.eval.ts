import { evaluate, expect } from 'reeval'
import { marked, plain } from './env.ts'

// Measure a change: a row per arm, `N of M` and the effect, then the checks that failed in some arm.
evaluate('lands', { compare: { control: plain, variants: [marked] } }, async (c) => {
  await expect(c, 'has the marker').toHaveFile('marker.txt')
})
