import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// Must fail: the limits it can check still fail, here a tool count below the turn's.
evaluate('canary', { environments: plain }, async (c) => {
  const turn = await c.send('look around')
  expect(turn).toStayWithin({ toolCalls: 0, duration: '5m' })
})
