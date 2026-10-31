import { evaluate, expect } from 'reeval'
import { tokens } from './env.ts'

// Must fail: the checks aren't kept from the secret the way the agent is.
evaluate('canary', { environments: tokens }, async (c) => {
  const seen = (await c.exec('printf %s "$CHECK_TOKEN"')).stdout
  expect(seen).toBe('')
})
