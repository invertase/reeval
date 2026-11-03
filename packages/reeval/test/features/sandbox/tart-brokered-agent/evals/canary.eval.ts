import { evaluate, expect } from 'reeval'
import { agentSaw, mac } from './env.ts'

// Must fail: the agent never holds the host's key.
evaluate('canary', { environments: mac }, async (c) => {
  const [key] = agentSaw(await c.send('which key do I have'))
  expect(key).toBe('key_tart_fixture')
})
