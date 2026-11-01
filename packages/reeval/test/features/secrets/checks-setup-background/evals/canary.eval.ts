import { evaluate, expect } from 'reeval'
import { agentSaw, brokered } from './env.ts'

// Must fail: brokered with hosts, setup's process holds only a placeholder.
evaluate('canary', { environments: brokered }, async (c) => {
  expect(agentSaw(await c.send('look for CHECK_TOKEN'))).toBe('value')
})
