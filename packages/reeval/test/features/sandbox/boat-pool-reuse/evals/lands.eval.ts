import { evaluate, expect } from 'reeval'
import { agentSaw, vm } from './env.ts'

// Whichever attempt the machine runs second finds nothing the first left behind.
evaluate('lands', { environments: vm }, async (c) => {
  const saw = agentSaw(await c.send('what did the last attempt leave?'))
  expect(saw.slice(0, 3).join(' ')).toBe('home-clean tmp-clean proc-clean')
})
