import { evaluate, expect } from 'reeval'
import { agentSaw, brokered } from './env.ts'

// Must fail: the request was refused.
evaluate('canary', { environments: brokered }, async (c) => {
  const [body] = agentSaw(await c.send('search the web'))
  expect(body).not.toContain('carries a brokered credential')
})
