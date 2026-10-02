import { evaluate } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environment: plain }, async (c) => {
  await c.sandbox()
  await c.capture({ name: 'x', path: '/', port: 9 })
})
