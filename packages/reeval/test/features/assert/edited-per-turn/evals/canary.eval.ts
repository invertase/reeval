import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environments: plain }, async (c) => {
  await c.send('write notes.txt from the shell')
  const second = await c.send('read notes.txt')
  // The first turn wrote notes.txt; the second only read it.
  expect(second).toHaveEdited('notes.txt')
})
