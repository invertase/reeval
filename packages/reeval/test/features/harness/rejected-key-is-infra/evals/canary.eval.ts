import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// Must fail: an ordinary provider error is the agent's turn failing, so c.send returns it.
evaluate('canary', { environment: plain }, async (c) => {
  const turn = await c.send('Reply with the word hi.')
  expect(turn.status).toBe('completed')
})
