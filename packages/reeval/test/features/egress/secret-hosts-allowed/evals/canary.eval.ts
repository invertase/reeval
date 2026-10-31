import { evaluate, expect } from 'reeval'
import { agentSaw, closed } from './env.ts'

// Must fail: without the secret, deny-all refuses its host.
evaluate('canary', { environments: closed }, async (c) => {
  const [body] = agentSaw(await c.send('fetch the listener'))
  expect(body?.trim()).toBe('reeval-egress-ok')
})
