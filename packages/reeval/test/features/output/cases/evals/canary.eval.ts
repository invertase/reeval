import { evaluate, expect } from 'reeval'

// Must fail: green isn't red, so that case fails the eval, and its case table marks it.
evaluate('canary', { cases: ['red', 'green'] }, async (_c, color) => {
  expect(color, 'is red').toBe('red')
})
