import { evaluate, expect } from 'reeval'
import { tokens } from './env.ts'

// Must fail: the checks aren't kept from the secret the way the agent is.
evaluate('canary', { environment: tokens }, async (c) => {
  const box = await c.sandbox()
  const seen = (await box.exec('printf %s "$CHECK_TOKEN"')).stdout
  expect(seen).toBe('')
})
