import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environment: plain }, async (c) => {
  const turn = await c.send('write notes.txt')
  expect(turn).toHaveEdited('other.txt')
})
