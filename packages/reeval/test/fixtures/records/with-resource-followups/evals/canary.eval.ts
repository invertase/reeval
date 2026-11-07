import { evaluate, expect } from 'reeval'
import { busy, CPU_SECONDS } from './env.ts'

// Must fail: nothing burned the CPU, so the container has used well under two seconds of it.
evaluate('canary', { environments: busy }, async (c) => {
  expect(Number((await c.exec(CPU_SECONDS)).stdout)).toBeGreaterThanOrEqual(2)
})
