import { evaluate, expect } from 'reeval'

// Must fail: green isn't red, so its row indents the failed check.
evaluate.each(['red', 'green'])('canary %s', async (_c, colour) => {
  expect(colour, 'is red').toBe('red')
})
