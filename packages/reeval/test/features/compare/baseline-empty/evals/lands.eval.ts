import { evaluate, expect } from 'reeval'
import { variant } from './env.ts'

// No baseline and no environments: the control is an empty environment, without the variant's files.
evaluate('lands', { compare: { variants: [variant], gate: 'all' } }, async (c) => {
  if (c.attempt.cell.role !== 'control') return
  expect(await c.readFile('from-variant.txt')).toBe(null)
})
