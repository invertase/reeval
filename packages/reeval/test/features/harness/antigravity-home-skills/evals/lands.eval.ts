import { evaluate, expect } from 'reeval'
import { greeting, shellOutput } from './env.ts'

// Under Antigravity, a harness-placed skill is in ~/.gemini/config/skills, where the CLI reads it.
evaluate('lands', { environment: greeting }, async (c) => {
  const turn = await c.send('read the house greeting skill')
  expect(shellOutput(turn, 0)).toContain('Greet people with "Ahoy, <name>!".')
})
