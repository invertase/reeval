import { evaluate, expect } from 'reeval'
import { agentSaw, finishes } from './env.ts'

// Must fail: no process the setup step started is still running.
evaluate('canary', { environment: finishes }, async (c) => {
  expect(agentSaw(await c.send('look for CHECK_TOKEN'))).toBe('value')
})
