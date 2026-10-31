import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environments: plain }, async (c) => {
  const turn = await c.send('look around')
  expect(turn).toStayWithin({ tokens: 1200, toolCalls: { bash: 2 }, duration: '5m' })
  expect(c).toStayWithin({ toolCalls: 2 })
})
