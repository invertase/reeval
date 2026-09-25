import { evaluate, expect } from 'evalsuite'
import { agentSaw, open } from './env.ts'

// Must fail: under allow-all the same direct connection reaches the listener, so it's reachable.
evaluate('canary', { environment: open }, async (t) => {
  const [direct] = agentSaw(await t.send('reach the listener'))
  expect(direct?.trim()).toMatch(/^000 exit=[1-9]\d*$/)
})
