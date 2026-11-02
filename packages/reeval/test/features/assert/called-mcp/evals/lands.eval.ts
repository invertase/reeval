import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environments: plain }, async (c) => {
  const turn = await c.send('call house_stamp')
  expect(turn).toHaveCalledMcp('stamp', 'house_stamp')
})
