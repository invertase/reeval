import { evaluate, expect } from 'evalsuite'
import { agentSaw, closed } from './env.ts'

// Must fail: without the secret, deny-all refuses its host.
evaluate('canary', { environment: closed }, async (t) => {
  const [body] = agentSaw(await t.send('fetch the listener'))
  expect(body?.trim()).toBe('es-egress-ok')
})
