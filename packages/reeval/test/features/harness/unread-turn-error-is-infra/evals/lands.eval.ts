import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// The turn errors and the body never reads `turn.status`, so although its check holds the
// attempt is an infra error (features.test.ts checks the record and the exit code).
evaluate('lands', { environments: plain }, async (c) => {
  await c.send('Reply with the word hi.')
  const r = await c.exec('true')
  expect(r.exitCode).toBe(0)
})
