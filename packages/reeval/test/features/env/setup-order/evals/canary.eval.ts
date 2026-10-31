import { evaluate, expect } from 'reeval'
import { ordered } from './env.ts'

// Must fail: the extending environment's step doesn't run first.
evaluate('canary', { environments: ordered }, async (c) => {
  expect(await c.readFile('order.txt')).toBe('two\none\n')
})
