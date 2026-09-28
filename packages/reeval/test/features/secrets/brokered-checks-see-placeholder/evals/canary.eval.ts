import { evaluate, expect } from 'reeval'
import { keys } from './env.ts'

// Must fail: the checks don't get the host value either.
evaluate('canary', { environment: keys }, async (t) => {
  const box = await t.sandbox()
  const seen = (await box.exec('printf %s "$CHECK_TOKEN"')).stdout
  expect(seen).toBe(process.env.REEVAL_FIXTURE_TOKEN)
})
