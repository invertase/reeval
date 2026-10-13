import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('canary', { environment: ui }, async (c) => {
  await c.sandbox()
  const server = await c.serve('node server.mjs')
  const [home] = await Promise.all([
    c.capture(server, { name: 'home' }),
    c.capture(server, { name: 'about', path: '/about' }),
  ])
  expect(home.file.path).toBe('artifacts/wrong.png')
})
