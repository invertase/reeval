import { evaluate, expect } from 'evalsuite'
import { ordered } from './env.ts'

// Must fail: the extending environment's step doesn't run first.
evaluate('canary', { environment: ordered }, async (t) => {
  const box = await t.sandbox()
  expect(await box.readFile('order.txt')).toBe('two\none\n')
})
