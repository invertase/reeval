import { evaluate, expect } from 'reeval'

// An eval with cases: its name heading, then a row per case.
evaluate('lands', { cases: ['red', 'blue'] }, async (_c, color) => {
  expect(color.length, 'named').toBeGreaterThan(0)
})
