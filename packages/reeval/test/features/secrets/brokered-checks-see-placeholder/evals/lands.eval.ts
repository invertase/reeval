import { evaluate, expect } from 'reeval'
import { keys } from './env.ts'

// A brokered `to: 'checks'` secret reaches c.exec as a placeholder, not the host value.
evaluate('lands', { environment: keys }, async (c) => {
  const box = await c.sandbox()
  const seen = (await box.exec('printf %s "$CHECK_TOKEN"')).stdout
  expect(seen).toMatch(/^reeval_secret_[0-9A-Za-z]{32}$/)
  expect(seen).not.toBe(process.env.REEVAL_FIXTURE_TOKEN)
})
