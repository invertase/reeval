import { evaluate, expect } from 'reeval'
import { FIND_SAMPLER, watched } from './env.ts'

// Must fail: there is no sampler in the container to kill.
evaluate('canary', { environments: watched }, async (c) => {
  expect((await c.exec(FIND_SAMPLER)).stdout.trim()).toBe('killed')
})
