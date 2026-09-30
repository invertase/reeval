import { evaluate, expect } from 'reeval'
import { variant } from './env.ts'

// No baseline and no environment: the control is an empty environment, without the variant's files.
evaluate('lands', { compare: { variants: [variant], gate: 'all' } }, async (c) => {
  if (c.attempt.cell.role !== 'control') return
  const box = await c.sandbox()
  expect(await box.readFile('from-variant.txt')).toBe(null)
})
