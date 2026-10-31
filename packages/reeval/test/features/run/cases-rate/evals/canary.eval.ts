import { evaluate, expect } from 'reeval'

// Must fail: the same rate of 0.67 is below 0.7.
evaluate('canary', { gate: { passRate: 0.7 }, cases: ['a', 'b', 'c'] }, async (c, key) => {
  expect(key, 'passes its case').not.toBe(await c.readFile('failing.txt'))
})
