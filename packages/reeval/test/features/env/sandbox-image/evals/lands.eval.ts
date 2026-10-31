import { evaluate, expect } from 'reeval'
import { python } from './env.ts'

// The cell's sandbox id is the environment's, not an implicit default.
evaluate('lands', { environments: python }, async (c) => {
  expect(c.attempt.cell.sandbox).toBe('python')
})
