import { evaluate, expect } from 'reeval'
import { agentSaw, closed } from './env.ts'

// The agent runs as reeval in a container of the recipe's image, and under deny-all its only way
// out is the gateway, which refuses the listener.
evaluate('lands', { environments: closed }, async (c) => {
  const [baked, user, direct, proxied] = agentSaw(await c.send('where am I'))
  expect([baked, user]).toEqual(['baked-by-boat-image', 'reeval'])
  expect(direct).toMatch(/^000 exit=[1-9]\d*$/)
  expect(proxied).not.toBe('200')
})
