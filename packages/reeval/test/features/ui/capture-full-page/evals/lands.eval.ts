import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('lands', { environments: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  const shot = await c.capture(server, { name: 'tall', viewport: 'full-page' })
  expect(shot.file.path).toBe('artifacts/tall.png')
  expect(shot.viewport).toBe('full-page')
})
