import { evaluate, expect } from 'reeval'
import { greeting, shellOutput } from './env.ts'

// Must fail: the skill isn't also in the directory it must not be in (the agent's second read).
evaluate('canary', { environment: greeting }, async (c) => {
  const turn = await c.send('read the house greeting skill')
  expect(shellOutput(turn, 1)).toContain('Greet people with "Ahoy, <name>!".')
})
