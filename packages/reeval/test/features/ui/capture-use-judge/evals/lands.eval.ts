import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('lands', { environment: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  const shot = await c.capture(server, { name: 'journey', instructions: ['Open the menu'] })
  expect(shot.file.path).toBe('artifacts/journey.png')
})
