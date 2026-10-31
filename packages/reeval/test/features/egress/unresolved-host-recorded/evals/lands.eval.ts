import { evaluate, expect } from 'reeval'
import { agentSaw, proxied } from './env.ts'

// A name that doesn't resolve gets the lookup's error, not a policy refusal.
evaluate('lands', { environments: proxied }, async (c) => {
  const [body] = agentSaw(await c.send('fetch a host that does not exist'))
  expect(body?.trim()).toMatch(/^reeval egress gateway can't resolve reeval-missing\.invalid: /)
})
