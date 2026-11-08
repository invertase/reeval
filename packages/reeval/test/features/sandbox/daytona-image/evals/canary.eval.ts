import { evaluate, expect } from 'reeval'
import { agentSaw, vm } from './env.ts'

// Must fail: the sandbox logs in as root, but the agent isn't root.
evaluate('canary', { environments: vm }, async (c) => {
  const [user] = agentSaw(await c.send('what is here'))
  expect(user).toBe('root')
})
