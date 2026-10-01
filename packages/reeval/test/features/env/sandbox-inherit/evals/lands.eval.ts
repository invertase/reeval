import { evaluate, expect } from 'reeval'
import { plain, skilled } from './env.ts'

// The cell's sandbox is the root machine, not the config environment's.
evaluate('lands', { compare: { baseline: plain, variants: [skilled] } }, async (c) => {
  expect(c.attempt.cell.sandbox).toBe('from-root')
})
