import { assert, evaluate } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environment: plain }, async (c) => {
  const turn = await c.send('call house_stamp')
  assert(turn).calledTool('mcp__stamp__house_stamp')
})
