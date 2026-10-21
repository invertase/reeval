import { evaluate, expect } from 'reeval'

// A family: the template heading, then a row per case.
evaluate.each(['red', 'blue'])('lands %s', async (_c, colour) => {
  expect(colour.length, 'named').toBeGreaterThan(0)
})
