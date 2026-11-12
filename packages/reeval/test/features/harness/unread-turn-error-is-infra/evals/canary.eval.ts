import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// Must fail: the body reads `turn.status`, so the errored turn is its own to judge and fails the
// attempt as an assertion.
evaluate('canary', { environments: plain }, async (c) => {
  const turn = await c.send('Reply with the word hi.')
  expect(turn.status).toBe('completed')
})
