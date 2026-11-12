import { evaluate, expect } from 'reeval'
import { HOLD, vm } from './env.ts'

// While the command runs, the run's heartbeats name the machine the attempt holds a slot on.
evaluate('lands', { environments: vm }, async (c) => {
  expect((await c.exec(HOLD)).stdout.trim()).toBe('held')
})
