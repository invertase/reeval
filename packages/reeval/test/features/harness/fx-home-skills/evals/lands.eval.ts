import { evaluate, expect } from 'reeval'
import { greeting, shellOutput } from './env.ts'

// Under fx, a harness-placed skill is in .fx/skills under the private home it runs with.
evaluate('lands', { environment: greeting }, async (c) => {
  const turn = await c.send('read the house greeting skill')
  expect(shellOutput(turn, 0)).toContain('Greet people with "Ahoy, <name>!".')
})
