import { evaluate, expect } from 'reeval'
import { keys } from './env.ts'

// The host value of a brokered secret, inside a longer value, reaches the command as the
// environment's placeholder for it.
evaluate('lands', { environments: keys }, async (c) => {
  const env = { AUTH: `Bearer ${process.env.REEVAL_FIXTURE_TOKEN}` }
  const seen = (await c.exec('printf %s "$AUTH"', { env })).stdout
  const placeholder = (await c.exec('printf %s "$CHECK_TOKEN"')).stdout
  expect(seen).toBe(`Bearer ${placeholder}`)
})
