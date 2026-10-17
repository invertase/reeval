import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('canary', { environment: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  const home = await c.capture(server, { name: 'home' })
  expect(home.file.path).toBe('artifacts/wrong.png')
})
