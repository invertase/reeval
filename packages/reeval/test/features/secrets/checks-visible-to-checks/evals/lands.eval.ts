import { evaluate, expect } from 'reeval'
import { tokens } from './env.ts'

// A `to: 'checks'` secret reaches c.exec, with the host variable's value.
evaluate('lands', { environments: tokens }, async (c) => {
  const seen = (await c.exec('printf %s "$CHECK_TOKEN"')).stdout
  expect(seen).toBe(process.env.REEVAL_FIXTURE_TOKEN)
})
