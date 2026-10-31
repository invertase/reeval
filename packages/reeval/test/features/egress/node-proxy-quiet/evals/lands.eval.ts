import { evaluate, expect } from 'reeval'
import { agentSaw, quiet } from './env.ts'

// Node's fetch reaches the host through the gateway's proxy, and Node prints nothing else.
evaluate('lands', { environments: quiet }, async (c) => {
  const [output] = agentSaw(await c.send('fetch the listener with node'))
  expect(output?.trim()).toBe('reeval-egress-ok')
})
