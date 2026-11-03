import { evaluate, expect } from 'reeval'
import { agentSaw, direct, open } from './env.ts'

// Must fail: under one allow-all policy the agent and the check reach the listener too.
evaluate('canary', { environments: open }, async (c) => {
  const [agent] = agentSaw(await c.send('reach the listener'))
  const check = await c.exec(direct)
  const seen = [await c.readFile('setup.txt'), agent, check.stdout].map((s) => s?.trim())
  expect(seen.join(' · ')).toMatch(/^200 exit=0 · 000 exit=[1-9]\d* · 000 exit=[1-9]\d*$/)
})
