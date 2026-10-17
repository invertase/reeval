import { evaluate, expect } from 'reeval'
import { ordered } from './env.ts'

// Setup steps run in order, the parent environment's first, each to completion.
evaluate('lands', { environment: ordered }, async (c) => {
  expect(await c.readFile('order.txt')).toBe('one\ntwo\n')
})
