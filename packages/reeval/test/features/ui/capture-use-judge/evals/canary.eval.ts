import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('canary', { environment: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  const shot = await c.capture(server, { name: 'journey', instructions: ['Open the menu'] })
  // Wrong artifact name: the check must be able to fail.
  expect(shot.file.path).toBe('artifacts/wrong.png')
})
