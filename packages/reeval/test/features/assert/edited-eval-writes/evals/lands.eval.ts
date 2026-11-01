import { evaluate, expect } from 'reeval'
import { notes } from './env.ts'

evaluate('lands', { environment: notes }, async (c) => {
  await c.exec('echo changed > notes.txt')
  const turn = await c.send('read notes.txt')
  expect(turn).not.toHaveEdited('notes.txt')
})
