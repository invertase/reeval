import { evaluate, expect } from 'reeval'
import { greeting, shellOutput } from './env.ts'

// Must fail: reeval doesn't put the skill in ~/.agents/skills, though OpenCode 2 reads that
// directory too.
evaluate('canary', { environment: greeting }, async (t) => {
  const turn = await t.send('read the house greeting skill')
  expect(shellOutput(turn, 1)).toContain('Greet people with "Ahoy, <name>!".')
})
