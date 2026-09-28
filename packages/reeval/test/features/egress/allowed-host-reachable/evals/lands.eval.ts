import { evaluate, expect } from 'reeval'
import { agentSaw, listed } from './env.ts'

// A host the policy allows is reachable from the sandbox.
evaluate('lands', { environment: listed }, async (t) => {
  const [body] = agentSaw(await t.send('fetch the listener'))
  expect(body?.trim()).toBe('reeval-egress-ok')
})
