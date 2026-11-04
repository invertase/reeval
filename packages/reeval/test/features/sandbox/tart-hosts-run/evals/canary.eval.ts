import { evaluate, expect } from 'reeval'
import { agentSaw, mac } from './env.ts'

// Must fail: no VM runs on this machine's Tart, whose VMs sit straight under vms/.
evaluate('canary', { environments: mac }, async (c) => {
  const [where] = agentSaw(await c.send('where am I'))
  expect(where).toMatch(/reeval-fake-tart-[^/]+\/vms\//)
})
