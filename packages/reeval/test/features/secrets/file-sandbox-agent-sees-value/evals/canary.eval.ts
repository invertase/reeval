import { evaluate, expect } from 'reeval'
import { agentSaw, keys } from './env.ts'

// Must fail: the agent gets the value, not a placeholder.
evaluate('canary', { environments: keys }, async (c) => {
  expect(agentSaw(await c.send('print API_KEY'))?.trim()).toMatch(/^reeval_secret_/)
})
