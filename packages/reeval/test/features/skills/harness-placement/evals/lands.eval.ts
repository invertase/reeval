import { evaluate, expect } from 'reeval'
import { greeting, prompt, shellOutput } from './env.ts'

// A harness-placed skill is in the agent's home, where the Cursor adapter puts it.
evaluate('lands', { environment: greeting }, async (c) => {
  const turn = await c.send(prompt)
  expect(shellOutput(turn, 0)).toContain('Greet people with "Ahoy, <name>!".')
})
