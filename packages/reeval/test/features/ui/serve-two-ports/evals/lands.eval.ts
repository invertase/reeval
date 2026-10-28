import { evaluate } from 'reeval'
import { ui } from './env.ts'

// c.serve fails, listing both ports, rather than guess one.
evaluate('lands', { environment: ui }, async (c) => {
  await c.serve('node server.mjs')
})
