import { evaluate, expect } from 'evalsuite'
import { keys } from './env.ts'

// A brokered `to: 'checks'` secret reaches t.exec as a placeholder, not the host value.
evaluate('lands', { environment: keys }, async (t) => {
  const box = await t.sandbox()
  const seen = (await box.exec('printf %s "$CHECK_TOKEN"')).stdout
  expect(seen).toMatch(/^es_secret_[0-9A-Za-z]{32}$/)
  expect(seen).not.toBe(process.env.ES_FIXTURE_TOKEN)
})
