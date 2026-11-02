import { evaluate, expect } from 'reeval'
import { child } from './env.ts'

// Must fail: the parent sandbox is not merged onto the child.
evaluate('canary', { environments: child }, async (c) => {
  expect(c.attempt.cell.sandbox).toBe('parent')
})
