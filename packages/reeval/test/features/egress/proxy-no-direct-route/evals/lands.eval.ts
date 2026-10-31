import { evaluate, expect } from 'reeval'
import { agentSaw, proxied } from './env.ts'

// Under the default policy the container has no network of its own: a raw TCP connection, which
// no proxy routes through the gateway, has nowhere to go.
evaluate('lands', { environments: proxied }, async (c) => {
  const [raw] = agentSaw(await c.send('connect over raw TCP'))
  expect(raw?.trim()).toMatch(/Network is unreachable[\s\S]* exit=[1-9]\d*$/)
})
