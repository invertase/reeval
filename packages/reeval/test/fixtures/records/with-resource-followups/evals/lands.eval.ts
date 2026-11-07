import { evaluate, expect } from 'reeval'
import { BURN, busy, CPU_SECONDS } from './env.ts'

// The burn uses the CPU and memory the record's resources then report.
evaluate('lands', { environments: busy }, async (c) => {
  await c.exec(BURN)
  expect(Number((await c.exec(CPU_SECONDS)).stdout)).toBeGreaterThanOrEqual(2)
})
