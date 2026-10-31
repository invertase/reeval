import { evaluate, expect } from 'reeval'
import { plain, skilled } from './env.ts'

// Must fail: the config environment's sandbox is not inherited.
evaluate('canary', { compare: { control: plain, variants: [skilled] } }, async (c) => {
  expect(c.attempt.cell.sandbox).toBe('from-config-env')
})
