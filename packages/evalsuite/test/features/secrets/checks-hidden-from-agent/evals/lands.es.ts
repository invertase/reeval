import { evaluate, expect } from 'evalsuite'
import { agentSaw, tokens } from './env.ts'

// A `to: 'checks'` secret isn't in the agent's environment.
evaluate('lands', { environment: tokens }, async (t) => {
  const turn = await t.send('print CHECK_TOKEN')
  expect(agentSaw(turn)).toBe('unset\n')
})
