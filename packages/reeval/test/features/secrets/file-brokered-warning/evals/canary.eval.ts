import { evaluate, expect } from 'reeval'
import { agentSaw, keys } from './env.ts'

// Must fail: the agent holds the placeholder, not the value.
evaluate('canary', { environments: keys }, async (c) => {
  const [key] = agentSaw(await c.send('send the keys'))
  expect(key).toBe('[REDACTED]')
})
