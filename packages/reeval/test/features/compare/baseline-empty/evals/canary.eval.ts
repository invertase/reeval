import { evaluate, expect } from 'reeval'
import { variant } from './env.ts'

// Must fail: the empty control doesn't get the variant's files. gate: 'all' gates the control.
evaluate('canary', { compare: { variants: [variant], gate: 'all' } }, async (c) => {
  if (c.attempt.cell.role !== 'control') return
  expect(await c.readFile('from-variant.txt')).toBe('variant-only')
})
