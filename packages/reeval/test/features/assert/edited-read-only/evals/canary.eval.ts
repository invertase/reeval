import { evaluate, expect } from 'reeval'
import { notes } from './env.ts'

evaluate('canary', { environment: notes }, async (c) => {
  const turn = await c.send('read notes.txt')
  // `cat notes.txt` names the file but doesn't change it.
  expect(turn).toHaveEdited('notes.txt')
})
