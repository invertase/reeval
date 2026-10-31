import { evaluate } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environments: plain, capture: { timeout: '2s' } }, async (c) => {
  await c.capture(59999, { name: 'gone' })
})
