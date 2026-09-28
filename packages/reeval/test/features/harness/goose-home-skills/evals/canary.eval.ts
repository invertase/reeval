import { evaluate, expect } from 'reeval'
import { greeting, shellOutput } from './env.ts'

// Must fail: the skill isn't in the sandbox user's ~/.config/goose/skills, since Goose runs with
// its own home.
evaluate('canary', { environment: greeting }, async (t) => {
  const turn = await t.send('read the house greeting skill')
  expect(shellOutput(turn, 1)).toContain('Greet people with "Ahoy, <name>!".')
})
