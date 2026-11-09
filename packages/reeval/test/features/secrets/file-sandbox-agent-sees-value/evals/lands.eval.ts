import { evaluate, expect } from 'reeval'
import { agentSaw, keys } from './env.ts'

// A sandbox-mode secret reaches the agent as its value. REEVAL_FIXTURE_TOKEN is the same value.
evaluate('lands', { environments: keys }, async (c) => {
  expect(agentSaw(await c.send('print API_KEY'))?.trim()).toBe(process.env.REEVAL_FIXTURE_TOKEN)
})
