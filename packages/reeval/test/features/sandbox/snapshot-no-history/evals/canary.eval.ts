import { evaluate, expect } from 'reeval'
import { agentSaw, seeded } from './env.ts'

evaluate('canary', { environments: seeded }, async (c) => {
  await c.send('Make a change.')
  await c.writeFile('src/sum.js', 'export const sum = (a, b) => a - b\n')
  const t2 = await c.send('Report.')
  const [probe] = agentSaw(t2)
  // Wrong: no snapshot the agent can reach keeps the seeded file as it was before the placement.
  expect(probe?.trim()).not.toBe('pre-seed content in: nowhere')
})
