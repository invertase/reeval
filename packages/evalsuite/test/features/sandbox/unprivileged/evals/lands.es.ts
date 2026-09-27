import { evaluate, expect } from 'evalsuite'
import { agentSaw, plain } from './env.ts'

// The agent and checks run as the unprivileged `es` user (uid 10001), with no capabilities.
evaluate('lands', { environment: plain }, async (t) => {
  const [agent] = agentSaw(await t.send('who are you'))
  const check = (await t.exec('id -u')).stdout
  expect(`${agent?.trim()} / ${check.trim()}`).toBe('10001 0000000000000000 / 10001')
})
