import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environment: plain }, async (c) => {
  const turn = await c.send('echo the contract token')
  expect(turn).toHaveRun(/contract-42/)
})
