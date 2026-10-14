import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('canary', { environment: ui }, async (c) => {
  await c.sandbox()
  const server = await c.serve('node server.mjs')
  const home = await c.capture(server, { name: 'home', wait: 'idle' })
  expect(home.file.path).toBe('artifacts/wrong.png')
})
