import { evaluate, expect } from 'reeval'
import { empty, variant } from './env.ts'

// An empty control runs without the variant's files.
evaluate('lands', { compare: { control: empty, variants: [variant], gate: 'all' } }, async (c) => {
  if (c.attempt.cell.role !== 'control') return
  expect(await c.readFile('from-variant.txt')).toBe(null)
})
