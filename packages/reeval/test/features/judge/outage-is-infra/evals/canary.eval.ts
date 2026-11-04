import { evaluate, expect } from 'reeval'
import { app, outage } from './env.ts'

// Must fail: the call answered nothing, so its verdict isn't 'pass'. A failed check beside the
// outage keeps the attempt a fail.
evaluate('canary', { environments: app }, async (c) => {
  await c.send('write the app')
  const verdict = await c.judge('Did the agent write the app?', { model: outage, diff: true })
  expect(verdict.verdict).toBe('pass')
  expect(verdict).toPass()
})
