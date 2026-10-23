import { evaluate, expect } from 'reeval'
import { agentSaw, open } from './env.ts'

// Under allow-all the container keeps its network: a raw TCP connection goes out directly, around
// the gateway, and reaches the listener.
evaluate('lands', { environment: open }, async (c) => {
  const [raw] = agentSaw(await c.send('connect over raw TCP'))
  expect(raw?.trim()).toBe('reeval-egress-ok exit=0')
})
