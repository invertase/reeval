import { evaluate, expect } from 'reeval'
import { agentSaw, tokens } from './env.ts'

// A `to: 'checks'` secret isn't in the agent's environment.
evaluate('lands', { environment: tokens }, async (c) => {
  const turn = await c.send('print CHECK_TOKEN')
  expect(agentSaw(turn)).toBe('unset\n')
})
