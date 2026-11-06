import { evaluate, expect } from 'reeval'
import { agentSaw, vm } from './env.ts'

// Must fail: the agent's start found the bootstrap done, so it didn't run it again.
evaluate('canary', { environments: vm }, async (c) => {
  const [runs] = agentSaw(await c.send('where was I installed'))
  expect(runs).toBe('2')
})
