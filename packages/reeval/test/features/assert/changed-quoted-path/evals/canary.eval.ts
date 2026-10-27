import { evaluate, expect } from 'reeval'
import { notes } from './env.ts'

evaluate('canary', { environment: notes }, async (c) => {
  await c.send('write the café note')
  // The agent did write notes/café.txt.
  expect(c).not.toHaveChanged('notes/café.txt')
})
