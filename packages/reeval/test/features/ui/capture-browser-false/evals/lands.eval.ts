import { evaluate } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environments: plain }, async (c) => {
  await c.capture(9, { name: 'x' })
})
