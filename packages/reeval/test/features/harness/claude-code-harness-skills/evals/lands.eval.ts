import { evaluate, expect } from 'reeval'
import { greeting, shellOutput } from './env.ts'

// Under Claude Code's layout, a harness-placed skill is in ~/.claude/skills, not Cursor's ~/.agents.
evaluate('lands', { environment: greeting }, async (t) => {
  const turn = await t.send('read the house greeting skill')
  expect(shellOutput(turn, 0)).toContain('Greet people with "Ahoy, <name>!".')
})
