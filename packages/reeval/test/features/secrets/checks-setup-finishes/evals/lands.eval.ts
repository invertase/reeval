import { evaluate, expect } from 'reeval'
import { agentSaw, finishes } from './env.ts'

// A setup step that finishes leaves no process holding the `to: 'checks'` secret, so nothing is
// recorded (checked from outside).
evaluate('lands', { environments: finishes }, async (c) => {
  expect(agentSaw(await c.send('look for CHECK_TOKEN'))).toBe('')
})
