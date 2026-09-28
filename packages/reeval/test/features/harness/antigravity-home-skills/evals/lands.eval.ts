import { evaluate, expect } from 'reeval'
import { greeting, shellOutput } from './env.ts'

// Under Antigravity, a harness-placed skill is in ~/.gemini/config/skills, where the CLI reads it.
evaluate('lands', { environment: greeting }, async (t) => {
  const turn = await t.send('read the house greeting skill')
  expect(shellOutput(turn, 0)).toContain('Greet people with "Ahoy, <name>!".')
})
