import { evaluate, expect } from 'reeval'
import { greeting, shellOutput } from './env.ts'

// Must fail: a harness-placed skill isn't also written into the workspace's .claude/skills.
evaluate('canary', { environment: greeting }, async (t) => {
  const turn = await t.send('read the house greeting skill')
  expect(shellOutput(turn, 1)).toContain('Greet people with "Ahoy, <name>!".')
})
