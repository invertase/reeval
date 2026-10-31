import { evaluate, expect } from 'reeval'
import { seeded } from './env.ts'

evaluate('lands', { environments: seeded }, async (c) => {
  await c.send('update the greet test')
  expect(c).toHaveChanged('test/**')
})
