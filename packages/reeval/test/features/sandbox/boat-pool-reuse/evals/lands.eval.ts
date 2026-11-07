import { evaluate, expect } from 'reeval'
import { agentSaw, vm } from './env.ts'

// The machine's first attempt finds it new and its second finds it reset, so either finds
// nothing left; the row's record check holds the one that ran second to it.
evaluate('lands', { environments: vm }, async (c) => {
  const saw = agentSaw(await c.send('what did the last attempt leave?'))
  expect(saw.slice(0, 3).join(' ')).toBe('home-clean tmp-clean proc-clean')
})
