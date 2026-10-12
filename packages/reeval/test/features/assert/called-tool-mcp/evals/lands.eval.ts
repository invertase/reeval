import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environment: plain }, async (c) => {
  const turn = await c.send('call house_stamp')
  expect(turn).toHaveCalledTool('mcp__stamp__house_stamp')
})
