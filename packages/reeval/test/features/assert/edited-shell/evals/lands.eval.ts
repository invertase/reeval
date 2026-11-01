import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environment: plain }, async (c) => {
  const turn = await c.send('write notes.txt from the shell')
  expect(turn).toHaveEdited()
})
