import { evaluate, expect } from 'reeval'
import { doubled, SWAP } from './env.ts'

// Must fail: without swap, docker({ memory: '512m' }) gets 512 MiB of swap, not 256.
evaluate('canary', { environment: doubled }, async (c) => {
  await c.sandbox()
  expect((await c.exec(SWAP)).stdout).toBe('268435456\n')
})
