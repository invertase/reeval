import { evaluate, expect } from 'reeval'
import { agentSaw, mac } from './env.ts'

// The one host preflight kept.
evaluate('lands', { environments: mac }, async (c) => {
  const [where] = agentSaw(await c.send('where am I'))
  expect(where).toMatch(/\/hosts\/mac-studio\/vms\/reeval-[^/]+\/home\//)
})
