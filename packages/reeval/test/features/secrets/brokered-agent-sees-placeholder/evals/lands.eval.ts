import { evaluate, expect } from 'reeval'
import { agentSaw, keys } from './env.ts'

// A secret with hosts reaches the agent as a placeholder; in Docker the gateway is its proxy.
evaluate('lands', { environments: keys }, async (c) => {
  const [key, proxy] = agentSaw(await c.send('print API_KEY'))
  expect(key).toMatch(/^reeval_secret_[0-9A-Za-z]{32}$/)
  expect(key).not.toBe(process.env.REEVAL_FIXTURE_TOKEN)
  if (['docker', 'podman'].includes(process.env.REEVAL_FIXTURE_SANDBOX ?? '')) {
    expect(proxy).toBe('http://127.0.0.1:43128')
  }
})
