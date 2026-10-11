import { evaluate, expect } from 'reeval'
import { greeting, shellOutput } from './env.ts'

// Must fail: the greeting is in the first shell output (index 0), not the second.
evaluate('canary', { environment: greeting }, async (c) => {
  const turn = await c.send('read the house greeting skill')
  expect(shellOutput(turn, 1)).toContain('Greet people with "Ahoy, <name>!".')
})
