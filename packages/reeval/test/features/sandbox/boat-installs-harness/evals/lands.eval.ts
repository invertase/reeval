import { evaluate, expect } from 'reeval'
import { agentSaw, vm } from './env.ts'

// The bootstrap ran once, in the agent's home, before its start was timed.
evaluate('lands', { environments: vm }, async (c) => {
  expect(agentSaw(await c.send('where was I installed')).slice(0, 2)).toEqual(['1', 'own'])
})
