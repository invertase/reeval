import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environments: plain }, async (c) => {
  const turn = await c.send('write notes.txt from the shell')
  // The heredoc wrote notes.txt, not other.txt.
  expect(turn).toHaveEdited('other.txt')
})
