import { evaluate, expect } from 'evalsuite'
import { tokens } from './env.ts'

// A `to: 'checks'` secret reaches t.exec, with the host variable's value.
evaluate('lands', { environment: tokens }, async (t) => {
  const box = await t.sandbox()
  const seen = (await box.exec('printf %s "$CHECK_TOKEN"')).stdout
  expect(seen).toBe(process.env.ES_FIXTURE_TOKEN)
})
