import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environments: plain }, async (c) => {
  const turn = await c.send('write notes.txt')
  expect(turn).toHaveEdited('notes.txt')
})
