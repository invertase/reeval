import { evaluate, expect } from 'reeval'
import { greeting, shellOutput } from './env.ts'

// A harness-placed skill is where the harness's adapter puts it (the agent's first read).
evaluate('lands', { environment: greeting }, async (c) => {
  const turn = await c.send('read the house greeting skill')
  expect(shellOutput(turn, 0)).toContain('Greet people with "Ahoy, <name>!".')
})
