import { evaluate, expect } from 'reeval'

// One case of three fails, so the cell's rate over its cases is 0.67, which clears 0.6.
evaluate('lands', { gate: { passRate: 0.6 }, cases: ['a', 'b', 'c'] }, async (c, key) => {
  expect(key, 'passes its case').not.toBe(await c.readFile('failing.txt'))
})
