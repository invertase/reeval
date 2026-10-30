import { evaluate, expect } from 'reeval'
import { agentSaw, proxied } from './env.ts'

// Must fail: no policy refused the name, so the body doesn't say it did.
evaluate('canary', { environment: proxied }, async (c) => {
  const [body] = agentSaw(await c.send('fetch a host that does not exist'))
  expect(body).toContain('blocked by the reeval egress policy')
})
