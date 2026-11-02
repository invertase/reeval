import { evaluate, expect } from 'reeval'
import { notes } from './env.ts'

evaluate('lands', { environments: notes }, async (c) => {
  const turn = await c.send('read notes.txt')
  expect(turn).not.toHaveEdited('notes.txt')
})
