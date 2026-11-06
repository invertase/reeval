import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'
import { COMMAND, TOKEN } from './token.ts'

// The matcher compares the real values; only what a failure quotes is masked.
evaluate('lands', { environments: plain }, async (c) => {
  const r = await c.exec(...COMMAND)
  expect(r.stdout).toBe(`nope ${TOKEN}`)
})
