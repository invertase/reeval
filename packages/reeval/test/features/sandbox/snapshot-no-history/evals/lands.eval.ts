import { evaluate, expect } from 'reeval'
import { agentSaw, seeded } from './env.ts'

evaluate('lands', { environment: seeded }, async (c) => {
  await c.writeFile('src/sum.js', 'export const sum = (a, b) => a - b\n')
  const [agent] = agentSaw(await c.send('Fix sum.'))
  expect(agent?.trim()).toBe('pre-seed content in: nowhere')
})
