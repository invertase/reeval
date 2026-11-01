import { evaluate, expect } from 'reeval'
import { agentSaw, open } from './env.ts'

// Must fail: under allow-all the container keeps its network, and the connection reaches the listener.
evaluate('canary', { environments: open }, async (c) => {
  const [raw] = agentSaw(await c.send('connect over raw TCP'))
  expect(raw?.trim()).toMatch(/Network is unreachable[\s\S]* exit=[1-9]\d*$/)
})
