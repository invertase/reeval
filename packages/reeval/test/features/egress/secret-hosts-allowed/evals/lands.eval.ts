import { evaluate, expect } from 'reeval'
import { agentSaw, keyed } from './env.ts'

// Under deny-all a brokered secret's hosts are allowed, so its API stays reachable.
evaluate('lands', { environment: keyed }, async (c) => {
  const [body] = agentSaw(await c.send('fetch the listener'))
  expect(body?.trim()).toBe('reeval-egress-ok')
})
