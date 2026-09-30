import { evaluate, expect } from 'reeval'
import { agentSaw, plain } from './env.ts'

// The agent and checks run as the unprivileged `reeval` user (uid 10001), with no capabilities.
evaluate('lands', { environment: plain }, async (c) => {
  const [agent] = agentSaw(await c.send('who are you'))
  const check = (await c.exec('id -u')).stdout
  expect(`${agent?.trim()} / ${check.trim()}`).toBe('10001 0000000000000000 / 10001')
})
