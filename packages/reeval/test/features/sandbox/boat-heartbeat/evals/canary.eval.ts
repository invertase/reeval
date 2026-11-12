import { evaluate, expect } from 'reeval'
import { HOLD, vm } from './env.ts'

// Must fail: the command prints held.
evaluate('canary', { environments: vm }, async (c) => {
  expect((await c.exec(HOLD)).stdout.trim()).toBe('released')
})
