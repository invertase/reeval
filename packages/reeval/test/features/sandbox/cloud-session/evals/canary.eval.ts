import { evaluate, expect } from 'reeval'
import { agentSaw, vm } from './env.ts'

// Must fail: the agent isn't the VM's login user.
evaluate('canary', { environments: vm }, async (c) => {
  const [user] = agentSaw(await c.send('where am I'))
  expect(user).toBe('user')
})
