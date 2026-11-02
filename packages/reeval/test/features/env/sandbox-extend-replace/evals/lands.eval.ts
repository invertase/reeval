import { evaluate, expect } from 'reeval'
import { child } from './env.ts'

// `.extend` replaces the parent's sandbox; the cell uses the child's.
evaluate('lands', { environments: child }, async (c) => {
  expect(c.attempt.cell.sandbox).toBe('child')
})
