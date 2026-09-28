import { evaluate, expect } from 'evalsuite'
import { agentSaw, keys } from './env.ts'

// Must fail: the agent doesn't get the host value.
evaluate('canary', { environment: keys }, async (t) => {
  const [key] = agentSaw(await t.send('print API_KEY'))
  expect(key).toBe(process.env.ES_FIXTURE_TOKEN)
})
