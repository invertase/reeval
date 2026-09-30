import { evaluate, expect } from 'reeval'
import { greeting, shellOutput } from './env.ts'

// Under Codex, a harness-placed skill is in ~/.agents/skills, its user skill directory.
evaluate('lands', { environment: greeting }, async (c) => {
  const turn = await c.send('read the house greeting skill')
  expect(shellOutput(turn, 0)).toContain('Greet people with "Ahoy, <name>!".')
})
