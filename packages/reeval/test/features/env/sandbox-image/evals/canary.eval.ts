import { evaluate, expect } from 'reeval'
import { python } from './env.ts'

// Must fail: a different sandbox id is not what the environment set.
evaluate('canary', { environments: python }, async (c) => {
  expect(c.attempt.cell.sandbox).toBe('docker')
})
