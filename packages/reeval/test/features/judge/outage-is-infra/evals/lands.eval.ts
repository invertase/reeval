import { evaluate, expect } from 'reeval'
import { app, outage } from './env.ts'

// A judge call the provider never answered fails the attempt as an infra error, not the agent's
// fail (features.test.ts checks the record), so --retry-errors runs it again.
evaluate('lands', { environments: app }, async (c) => {
  await c.send('write the app')
  const verdict = await c.judge('Did the agent write the app?', { model: outage, diff: true })
  expect(verdict.verdict).toBe('error')
  expect(verdict).toPass()
})
