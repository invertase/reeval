import { evaluate } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environments: plain, capture: { timeout: '60s' } }, async (c) => {
  await c.exec('true')
})
