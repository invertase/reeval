import { evaluate, expect } from 'evalsuite'
import { agentSaw, closed } from './env.ts'

// Must fail: under deny-all the same request gets the gateway's refusal.
evaluate('canary', { environment: closed }, async (t) => {
  const [body] = agentSaw(await t.send('fetch the listener'))
  expect(body?.trim()).toBe('es-egress-ok')
})
