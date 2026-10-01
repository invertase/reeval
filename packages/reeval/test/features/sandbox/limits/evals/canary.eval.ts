import { evaluate, expect } from 'reeval'
import { LIMITS, unlimited } from './env.ts'

// Must fail: plain docker() has the default limits (4g memory, 1024 processes).
evaluate('canary', { environment: unlimited }, async (c) => {
  await c.sandbox()
  expect((await c.exec(LIMITS)).stdout).toBe('536870912\n100000 100000\n256\n')
})
