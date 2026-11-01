import { evaluate, expect } from 'reeval'
import { keys } from './env.ts'

// Must fail: the checks don't get the host value either.
evaluate('canary', { environments: keys }, async (c) => {
  const seen = (await c.exec('printf %s "$CHECK_TOKEN"')).stdout
  expect(seen).toBe(process.env.REEVAL_FIXTURE_TOKEN)
})
