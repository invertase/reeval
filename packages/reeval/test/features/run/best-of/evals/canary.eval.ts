import { evaluate, expect } from 'reeval'

// Must fail: every attempt expects the wrong word, so the first two agree and the third never runs.
evaluate('canary', { runs: { bestOf: 3 } }, async (c) => {
  expect(await c.readFile('word.txt')).toBe('hello')
})
