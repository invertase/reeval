import { evaluate, expect } from 'evalsuite'
import { greeting, shellOutput } from './env.ts'

// Under OpenCode, a harness-placed skill is in ~/.config/opencode/skills, its own global directory.
evaluate('lands', { environment: greeting }, async (t) => {
  const turn = await t.send('read the house greeting skill')
  expect(shellOutput(turn, 0)).toContain('Greet people with "Ahoy, <name>!".')
})
