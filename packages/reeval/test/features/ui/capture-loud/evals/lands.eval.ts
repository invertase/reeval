import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('lands', { environments: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  const shot = await c.capture(server, { name: 'loud', wait: { ms: 1000 }, timeout: '40s' })
  expect(shot).toHaveStatus(200)
  expect(shot).toHaveNoPageErrors()
  expect(shot.console).toHaveLength(100)
  expect(shot.dropped).toBe(1201)
})
