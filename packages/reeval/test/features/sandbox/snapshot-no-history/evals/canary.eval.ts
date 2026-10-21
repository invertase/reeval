import { evaluate, expect } from 'reeval'
import { agentSaw, seeded } from './env.ts'

evaluate('canary', { environment: seeded }, async (c) => {
  await c.writeFile('src/sum.js', 'export const sum = (a, b) => a - b\n')
  const [agent] = agentSaw(await c.send('Fix sum.'))
  // Wrong: no snapshot the agent can reach keeps the file as it was before the seed.
  expect(agent?.trim()).not.toBe('pre-seed content in: nowhere')
})
