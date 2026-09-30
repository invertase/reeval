import { evaluate, expect } from 'reeval'
import { greeting, shellOutput } from './env.ts'

// Must fail: the skill goes to ~/.agents/skills, not ~/.codex/skills, where Codex
// used to read them.
evaluate('canary', { environment: greeting }, async (c) => {
  const turn = await c.send('read the house greeting skill')
  expect(shellOutput(turn, 1)).toContain('Greet people with "Ahoy, <name>!".')
})
