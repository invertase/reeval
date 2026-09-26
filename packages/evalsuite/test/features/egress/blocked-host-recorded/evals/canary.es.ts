import { evaluate, expect } from 'evalsuite'
import { agentSaw, listed } from './env.ts'

// Must fail: the request was refused.
evaluate('canary', { environment: listed }, async (t) => {
  const [body] = agentSaw(await t.send('fetch an unlisted host'))
  expect(body).not.toContain('blocked by the ES egress policy')
})
