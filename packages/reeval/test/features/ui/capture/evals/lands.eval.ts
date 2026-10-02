import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('lands', { environment: ui }, async (c) => {
  await c.sandbox()
  const server = await c.serve('node server.mjs')
  const home = await c.capture({ name: 'home', path: '/', port: server.port })
  expect(home.file.path).toBe('artifacts/home.png')
  expect(home.name).toBe('home')
  expect(home.file.bytes).toBeGreaterThan(0)
})
