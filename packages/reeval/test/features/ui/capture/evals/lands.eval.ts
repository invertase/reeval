import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('lands', { environments: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  const home = await c.capture(server, { name: 'home' })
  expect(home.file.path).toBe('artifacts/home.png')
  expect(home.name).toBe('home')
  expect(home.file.bytes).toBeGreaterThan(0)
})
