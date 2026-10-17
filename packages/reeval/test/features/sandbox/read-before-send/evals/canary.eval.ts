import { evaluate, expect } from 'reeval'
import { notes } from './env.ts'

// Must fail: no turn has run, so the agent hasn't written notes.txt yet.
evaluate('canary', { environment: notes }, async (c) => {
  expect(await c.readFile('notes.txt')).toBe('from the agent\n')
})
