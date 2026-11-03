import { evaluate, expect } from 'reeval'
import { agentSaw, phased } from './env.ts'

// Must fail: the agent finds the setup step's file, so it didn't start before setup finished.
evaluate('canary', { environments: phased }, async (c) => {
  const [read] = agentSaw(await c.send('read ready.txt'))
  expect(read?.trim()).toBe('')
})
