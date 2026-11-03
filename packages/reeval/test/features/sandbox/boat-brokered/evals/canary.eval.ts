import { evaluate, expect } from 'reeval'
import { agentSaw, keys } from './env.ts'

// Must fail: the agent doesn't get the host value.
evaluate('canary', { environments: keys }, async (c) => {
  const [key] = agentSaw(await c.send('print API_KEY'))
  expect(key).toBe(process.env.REEVAL_FIXTURE_TOKEN)
})
