import { assert, evaluate } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environment: plain }, async (c) => {
  const turn = await c.send('load the foo skill')
  assert(turn).calledSkill('foo')
})
