import { evaluate, expect } from 'reeval'
import { plain, skilled } from './env.ts'

// The cell's sandbox is the config environment's, not implicit Docker.
evaluate('lands', { compare: { baseline: plain, variants: [skilled] } }, async (c) => {
  expect(c.attempt.cell.sandbox).toBe('from-config')
})
