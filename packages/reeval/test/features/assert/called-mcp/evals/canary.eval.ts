import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environment: plain }, async (c) => {
  const turn = await c.send('call house_stamp')
  expect(turn).toHaveCalledMcp('stamp', 'other')
})
