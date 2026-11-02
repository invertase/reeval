import { evaluate } from 'reeval'
import { ui } from './env.ts'

// The model is the suite's scripted one: it clicks the same empty spot until reeval stops it.
evaluate('lands', { environments: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  await c.capture(server, { name: 'menu', instructions: ['Open the menu'] })
})
