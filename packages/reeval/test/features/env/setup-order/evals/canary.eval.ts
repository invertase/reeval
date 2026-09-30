import { evaluate, expect } from 'reeval'
import { ordered } from './env.ts'

// Must fail: the extending environment's step doesn't run first.
evaluate('canary', { environment: ordered }, async (c) => {
  const box = await c.sandbox()
  expect(await box.readFile('order.txt')).toBe('two\none\n')
})
