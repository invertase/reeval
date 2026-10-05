import { assert, evaluate } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environment: plain }, async (c) => {
  const turn = await c.send('write notes.txt')
  assert(turn).edited('notes.txt')
})
