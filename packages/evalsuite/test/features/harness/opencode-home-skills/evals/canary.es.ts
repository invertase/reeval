import { evaluate, expect } from 'evalsuite'
import { greeting, shellOutput } from './env.ts'

// Must fail: the skill isn't in ~/.agents/skills, which OpenCode would also read without
// OPENCODE_DISABLE_EXTERNAL_SKILLS.
evaluate('canary', { environment: greeting }, async (t) => {
  const turn = await t.send('read the house greeting skill')
  expect(shellOutput(turn, 1)).toContain('Greet people with "Ahoy, <name>!".')
})
