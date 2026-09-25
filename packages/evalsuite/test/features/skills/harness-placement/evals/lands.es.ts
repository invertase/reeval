import { evaluate, expect } from 'evalsuite'
import { greeting, shellOutput } from './env.ts'

// A harness-placed skill is in the agent's home, where the Cursor adapter puts it.
evaluate('lands', { environment: greeting }, async (t) => {
  const turn = await t.send('read the house greeting skill')
  expect(shellOutput(turn, 0)).toContain('Greet people with "Ahoy, <name>!".')
})
