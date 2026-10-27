import { evaluate, expect } from 'reeval'

evaluate('agrees', { runs: { bestOf: 3 } }, async (c) => {
  await c.send('hi')
  expect(1).toBe(1)
})
evaluate('splits', { runs: { bestOf: 3 } }, async (c) => {
  await c.send('hi')
  expect(c.attempt.n === 2 ? 0 : 1).toBe(1)
})
evaluate('fails twice', { runs: { bestOf: 5 } }, async (c) => {
  await c.send('hi')
  expect([1, 3, 4].includes(c.attempt.n) ? 0 : 1).toBe(1)
})
