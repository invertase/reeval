import { evaluate, expect } from 'reeval'

// An eval with cases is one row; every case passed, so it prints on one line.
evaluate('lands', { cases: ['red', 'blue'] }, async (_c, color) => {
  expect(color.length, 'named').toBeGreaterThan(0)
})
