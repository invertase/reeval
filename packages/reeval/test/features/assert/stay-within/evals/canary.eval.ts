import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// Must fail: one token below what the fake turn reports.
evaluate('canary', { environments: plain }, async (c) => {
  const turn = await c.send('look around')
  expect(turn).toStayWithin({ tokens: 1199 })
})
