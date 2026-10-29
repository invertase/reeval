import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('canary', { environment: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  const shot = await c.capture(server, { name: 'old', path: '/old' })
  // `/old` redirects to `/login`, which answers 404.
  expect(shot).toHaveStatus(200)
})
