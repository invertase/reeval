import { evaluate, expect } from 'evalsuite'
import { tokens } from './env.ts'

// Must fail: the checks aren't kept from the secret the way the agent is.
evaluate('canary', { environment: tokens }, async (t) => {
  const box = await t.sandbox()
  const seen = (await box.exec('printf %s "$CHECK_TOKEN"')).stdout
  expect(seen).toBe('')
})
