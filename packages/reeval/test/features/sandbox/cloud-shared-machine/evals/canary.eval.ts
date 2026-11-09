import { evaluate, expect } from 'reeval'
import { agentSaw, vm } from './env.ts'

// Must fail: neither slot's agent is the VM's login user.
evaluate('canary', { environments: vm }, async (c) => {
  const [user] = agentSaw(await c.send('where am I'))
  expect(user).toBe('user')
})
