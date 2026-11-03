import { evaluate, expect } from 'reeval'
import { agentSaw, direct, phased } from './env.ts'

// Setup runs under allow-all and reaches the listener directly; the agent's turn and the check
// after it run under deny-all, where the only route out is the gateway.
evaluate('lands', { environments: phased }, async (c) => {
  const [agent] = agentSaw(await c.send('reach the listener'))
  const check = await c.exec(direct)
  const seen = [await c.readFile('setup.txt'), agent, check.stdout].map((s) => s?.trim())
  expect(seen.join(' · ')).toMatch(/^200 exit=0 · 000 exit=[1-9]\d* · 000 exit=[1-9]\d*$/)
})
