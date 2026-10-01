import { evaluate, expect } from 'reeval'
import { plain, skilled } from './env.ts'

// Must fail: implicit Docker is not the config environment's sandbox.
evaluate('canary', { compare: { baseline: plain, variants: [skilled] } }, async (c) => {
  expect(c.attempt.cell.sandbox).toBe('docker')
})
