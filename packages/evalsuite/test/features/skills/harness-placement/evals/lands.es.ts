import { evaluate, expect } from 'evalsuite'
import { greeting, prompt, shellOutput } from './env.ts'

// A harness-placed skill is in the agent's home, where the Cursor adapter puts it.
evaluate('lands', { environment: greeting }, async (t) => {
  const turn = await t.send(prompt)
  expect(shellOutput(turn, 0)).toContain('Greet people with "Ahoy, <name>!".')
})
