import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environment: plain }, async (c) => {
  const turn = await c.send('echo the contract token')
  expect(turn).toHaveRun(/deploy/)
})
