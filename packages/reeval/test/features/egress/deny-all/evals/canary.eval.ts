import { evaluate, expect } from 'reeval'
import { agentSaw, open } from './env.ts'

// Must fail: under allow-all the same direct connection reaches the listener, and names resolve.
evaluate('canary', { environment: open }, async (c) => {
  const [direct, dns] = agentSaw(await c.send('reach the listener'))
  expect(`${direct?.trim()} ${dns?.trim()}`).toMatch(/^000 exit=[1-9]\d* dns=[1-9]\d*$/)
})
