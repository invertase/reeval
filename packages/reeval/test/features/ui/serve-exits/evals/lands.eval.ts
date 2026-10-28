import { evaluate } from 'reeval'
import { ui } from './env.ts'

// c.serve fails as soon as the command exits, with its last output.
evaluate('lands', { environment: ui }, async (c) => {
  await c.serve('node server.mjs')
})
