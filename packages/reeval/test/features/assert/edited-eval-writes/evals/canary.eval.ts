import { evaluate, expect } from 'reeval'
import { notes } from './env.ts'

evaluate('canary', { environment: notes }, async (c) => {
  await c.exec('echo changed > notes.txt')
  const turn = await c.send('read notes.txt')
  // The eval changed notes.txt before the turn; the agent only read it.
  expect(turn).toHaveEdited('notes.txt')
})
