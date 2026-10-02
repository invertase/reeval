import { evaluate } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environment: plain, capture: { timeout: '2s' } }, async (c) => {
  await c.sandbox()
  await c.capture({ name: 'gone', path: '/', port: 59999 })
})
