import { evaluate, expect } from 'reeval'
import { ordered } from './env.ts'

// Setup steps run in order, the parent environment's first, each to completion.
evaluate('lands', { environment: ordered }, async (t) => {
  const box = await t.sandbox()
  expect(await box.readFile('order.txt')).toBe('one\ntwo\n')
})
