import { evaluate, expect } from 'reeval'
import { FIND_SAMPLER, vm } from './env.ts'

// The VM's sampler runs as root, which the sandbox user can see but not signal.
evaluate('lands', { environments: vm }, async (c) => {
  expect((await c.exec(FIND_SAMPLER)).stdout.trim()).toBe('refused')
})
