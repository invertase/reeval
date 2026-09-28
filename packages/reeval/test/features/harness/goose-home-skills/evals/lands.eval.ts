import { evaluate, expect } from 'reeval'
import { greeting, shellOutput } from './env.ts'

// Under Goose, a harness-placed skill is in .config/goose/skills under the private home it runs with.
evaluate('lands', { environment: greeting }, async (t) => {
  const turn = await t.send('read the house greeting skill')
  expect(shellOutput(turn, 0)).toContain('Greet people with "Ahoy, <name>!".')
})
