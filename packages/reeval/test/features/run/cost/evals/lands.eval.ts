import { evaluate, expect } from 'reeval'
import { listed, reporter, unknown } from './agents.ts'

// A reported cost, an estimate at models.dev's list price, and no cost for an unlisted model.
evaluate('lands', { harnesses: [reporter, listed, unknown] }, async (c) => {
  const turn = await c.send('say hi')
  expect(turn.usage).not.toBeNull()
})
