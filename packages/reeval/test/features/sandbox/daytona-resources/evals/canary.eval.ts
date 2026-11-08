import { evaluate, expect } from 'reeval'
import { BURN, vm } from './env.ts'

// Must fail: the burn prints the VM's CPU count, which is never 0.
evaluate('canary', { environments: vm }, async (c) => {
  expect(Number((await c.exec(BURN)).stdout)).toBe(0)
})
