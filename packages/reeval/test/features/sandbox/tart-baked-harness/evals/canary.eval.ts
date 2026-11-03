import { evaluate, expect } from 'reeval'
import { agentSaw, mac } from './env.ts'

// Must fail: the attempt didn't install the agent itself.
evaluate('canary', { environments: mac }, async (c) => {
  const [where] = agentSaw(await c.send('where was I installed'))
  expect(where).toBe('here')
})
