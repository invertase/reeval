import { evaluate, expect } from 'reeval'
import { agentSaw, closed } from './env.ts'

// Under deny-all the sandbox has no route out but the gateway: a direct connection fails, and
// nothing resolves a name for it.
evaluate('lands', { environment: closed }, async (t) => {
  const [direct, dns] = agentSaw(await t.send('reach the listener'))
  expect(`${direct?.trim()} ${dns?.trim()}`).toMatch(/^000 exit=[1-9]\d* dns=[1-9]\d*$/)
})
