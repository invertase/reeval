import { evaluate, expect } from 'reeval'
import { keys } from './env.ts'

// Must fail: the command doesn't get the host value.
evaluate('canary', { environments: keys }, async (c) => {
  const env = { AUTH: `Bearer ${process.env.REEVAL_FIXTURE_TOKEN}` }
  const seen = (await c.exec('printf %s "$AUTH"', { env })).stdout
  expect(seen).toBe(`Bearer ${process.env.REEVAL_FIXTURE_TOKEN}`)
})
