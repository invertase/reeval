import { evaluate, expect } from 'reeval'
import { skilled } from './env.ts'

evaluate('lands', { environment: skilled }, async (c) => {
  const turn = await c.send('read the foo skill')
  expect(turn).toHaveCalledSkill('foo')
})
