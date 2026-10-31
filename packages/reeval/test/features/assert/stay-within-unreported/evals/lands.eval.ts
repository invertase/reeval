import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// An error, not a failure: the turn can't show it stayed within its tokens.
evaluate('lands', { environments: plain }, async (c) => {
  const turn = await c.send('look around')
  expect(turn).toStayWithin({ tokens: 10 })
})
