import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environments: plain }, async (c) => {
  const turn = await c.send('load the foo skill')
  expect(turn).toHaveCalledSkill('foo')
})
