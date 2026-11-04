import { evaluate, expect } from 'reeval'
import { agentSaw, mac } from './env.ts'

// Must fail: preflight skipped small, so no VM runs there.
evaluate('canary', { environments: mac }, async (c) => {
  const [where] = agentSaw(await c.send('where am I'))
  expect(where).toMatch(/\/hosts\/small\//)
})
