import { evaluate } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environment: plain, capture: { port: 5173 } }, async (c) => {
  await c.sandbox()
})
