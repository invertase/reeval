import { evaluate, expect } from 'reeval'
import { FIND_SAMPLER, vm } from './env.ts'

// Must fail: the sandbox user can't kill root's sampler.
evaluate('canary', { environments: vm }, async (c) => {
  expect((await c.exec(FIND_SAMPLER)).stdout.trim()).toBe('killed')
})
