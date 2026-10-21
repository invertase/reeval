import { evaluate, expect } from 'reeval'
import { copier, writer } from './agents.ts'
import { marked, plain } from './env.ts'

// Both: the harness outer, its arms inner.
evaluate(
  'lands',
  { harness: [writer, copier], compare: { baseline: plain, variants: [marked] } },
  async (c) => {
    await expect(c, 'has the marker').toHaveFile('marker.txt')
  },
)
