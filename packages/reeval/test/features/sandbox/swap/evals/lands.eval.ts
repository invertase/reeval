import { evaluate, expect } from 'reeval'
import { plain, SWAP } from './env.ts'

// docker({ swap }) reaches the container's cgroup, on top of memory.
evaluate('lands', { environments: plain }, async (c) => {
  expect((await c.exec(SWAP)).stdout).toBe('268435456\n')
})
