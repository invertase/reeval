import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environment: plain }, async (c) => {
  await c.send('write notes.txt from the shell')
  const second = await c.send('read notes.txt')
  expect(second).not.toHaveEdited('notes.txt')
})
