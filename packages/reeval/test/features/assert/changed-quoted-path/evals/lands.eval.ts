import { evaluate, expect } from 'reeval'
import { notes } from './env.ts'

evaluate('lands', { environments: notes }, async (c) => {
  await c.send('write the café note')
  expect(c).toHaveChanged('notes/café.txt')
})
