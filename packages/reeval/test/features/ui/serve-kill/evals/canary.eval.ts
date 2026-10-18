import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

// Must fail: after kill() the port is down, not up.
evaluate('canary', { environment: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  await c.exec(`node probe.mjs ${server.port} up`)
  await server.kill()
  const r = await c.exec(`node probe.mjs ${server.port} down`)
  expect(r.stdout).toBe('up')
})
