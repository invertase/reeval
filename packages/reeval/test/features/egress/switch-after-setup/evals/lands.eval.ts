import { evaluate, expect } from 'reeval'
import { agentSaw, phased } from './env.ts'

// The setup steps finish under the setup policy before the agent's turn starts under its own.
evaluate('lands', { environments: phased }, async (c) => {
  const [read] = agentSaw(await c.send('read ready.txt'))
  expect(read?.trim()).toBe('ready')
})
