import { evaluate } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environment: plain, capture: { port: 9 } }, async (c) => {
  await c.sandbox()
  await c.capture({ name: 'x', path: '/' })
})
