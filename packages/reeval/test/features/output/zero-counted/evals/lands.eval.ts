import { evaluate, expect } from 'reeval'
import { broken, plain } from './env.ts'

// The broken variant's setup can't start, so none of its attempts count: its cell still lists
// each check the control ran, as not run.
evaluate('lands', { compare: { baseline: plain, variants: [broken] } }, async (c) => {
  await expect(c.exec('true'), 'runs true').toSucceed()
  expect(c.attempt.cell.role, 'is the control').toBe('control')
})
