import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('lands', { environments: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  const [home, about] = await Promise.all([
    c.capture(server, { name: 'home' }),
    c.capture(server, { name: 'about', path: '/about' }),
  ])
  expect(home.file.path).toBe('artifacts/home.png')
  expect(about.file.path).toBe('artifacts/about.png')
  expect(home.file.bytes).toBeGreaterThan(0)
  expect(about.file.bytes).toBeGreaterThan(0)
})
