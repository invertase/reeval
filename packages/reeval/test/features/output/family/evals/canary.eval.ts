import { evaluate, expect } from 'reeval'

// Must fail: green isn't red, so its row indents the failed check.
evaluate('canary', { cases: ['red', 'green'] }, async (_c, color) => {
  expect(color, 'is red').toBe('red')
})
