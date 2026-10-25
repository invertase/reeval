import { evaluate, expect } from 'reeval'
import { pins } from './env.ts'

// Must fail: printenv prints PLACEHOLDER too.
evaluate('canary', { environment: pins }, async (c) => {
  await c.send('print PIN and PLACEHOLDER')
  expect((await c.exec('printenv PIN PLACEHOLDER')).stdout).toBe('1234\n')
})
