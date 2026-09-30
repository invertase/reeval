import { evaluate, expect } from 'reeval'
import { agentSaw, listed } from './env.ts'

// Must fail: the request was refused.
evaluate('canary', { environment: listed }, async (c) => {
  const [body] = agentSaw(await c.send('fetch an unlisted host'))
  expect(body).not.toContain('blocked by the reeval egress policy')
})
