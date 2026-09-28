import { evaluate, expect } from 'reeval'
import { agentSaw, keys } from './env.ts'

// A secret with hosts reaches the agent as a placeholder; in Docker the gateway is its proxy.
evaluate('lands', { environment: keys }, async (t) => {
  const [key, proxy] = agentSaw(await t.send('print API_KEY'))
  expect(key).toMatch(/^reeval_secret_[0-9A-Za-z]{32}$/)
  expect(key).not.toBe(process.env.REEVAL_FIXTURE_TOKEN)
  if (process.env.REEVAL_FIXTURE_SANDBOX === 'docker') expect(proxy).toBe('http://127.0.0.1:43128')
})
