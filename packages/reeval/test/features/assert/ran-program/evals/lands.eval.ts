import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environments: plain }, async (c) => {
  const turn = await c.send('print the contract token')
  expect(turn).toHaveRun({ program: 'printf', args: /^contract-42$/ })
})
