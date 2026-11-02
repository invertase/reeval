import { evaluate, expect } from 'reeval'
import { prompt, quick } from './env.ts'

// Must fail: a server that answers isn't timed out, so the turn's status is completed.
evaluate('canary', { environments: quick }, async (c) => {
  const turn = await c.send(prompt)
  expect(turn.status).toBe('error')
})
