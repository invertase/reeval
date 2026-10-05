import { assert, evaluate } from 'reeval'
import { skilled } from './env.ts'

evaluate('canary', { environment: skilled }, async (c) => {
  const turn = await c.send('read the foo skill')
  assert(turn).calledSkill('other')
})
