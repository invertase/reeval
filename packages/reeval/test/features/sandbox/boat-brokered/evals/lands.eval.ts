import { evaluate, expect } from 'reeval'
import { agentSaw, keys } from './env.ts'

// A secret with hosts reaches the agent on the VM as a placeholder; the value stays on the host.
evaluate('lands', { environments: keys }, async (c) => {
  const [key] = agentSaw(await c.send('print API_KEY'))
  expect(key).toMatch(/^reeval_secret_[0-9A-Za-z]{32}$/)
})
