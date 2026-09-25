import { evaluate, expect } from 'evalsuite'
import { agentSaw, closed } from './env.ts'

// Under deny-all the sandbox has no route out but the gateway: a direct connection fails.
evaluate('lands', { environment: closed }, async (t) => {
  const [direct] = agentSaw(await t.send('reach the listener'))
  expect(direct?.trim()).toMatch(/^000 exit=[1-9]\d*$/)
})
