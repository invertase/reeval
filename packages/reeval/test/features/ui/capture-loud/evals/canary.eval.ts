import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('canary', { environment: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  const shot = await c.capture(server, { name: 'loud', wait: { ms: 1000 }, timeout: '40s' })
  // The page handles its rejection later, so it has no page errors.
  expect(shot).not.toHaveNoPageErrors()
})
