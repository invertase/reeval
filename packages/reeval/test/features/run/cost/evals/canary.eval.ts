import { evaluate, expect } from 'reeval'
import { silent } from './agents.ts'

// Must fail: an agent that reports no tokens has nothing to price.
evaluate('canary', { harnesses: [silent] }, async (c) => {
  const turn = await c.send('say hi')
  expect(turn.usage).not.toBeNull()
})
