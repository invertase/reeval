import { evaluate, expect } from 'reeval'
import { agentSaw, unbrokered } from './env.ts'

// A process setup leaves running keeps an unbrokered `to: 'checks'` secret's real value in its
// environment, where the agent finds it; the record names the process (checked from outside).
evaluate('lands', { environment: unbrokered }, async (c) => {
  expect(agentSaw(await c.send('look for CHECK_TOKEN'))).toBe('value')
})
