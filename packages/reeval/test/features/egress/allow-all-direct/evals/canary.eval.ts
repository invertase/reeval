import { evaluate, expect } from 'reeval'
import { agentSaw, proxied } from './env.ts'

// Must fail: under the default, 'proxy', the container has no network for the connection to use.
evaluate('canary', { environment: proxied }, async (c) => {
  const [raw] = agentSaw(await c.send('connect over raw TCP'))
  expect(raw?.trim()).toBe('reeval-egress-ok exit=0')
})
