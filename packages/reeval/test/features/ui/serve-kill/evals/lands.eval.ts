import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

// kill() stops what a compound command started, not only the shell that waits on it.
evaluate('lands', { environment: ui }, async (c) => {
  const server = await c.serve('node server.mjs || echo crashed')
  await c.exec(`node probe.mjs ${server.port} up`)
  await server.kill()
  const r = await c.exec(`node probe.mjs ${server.port} down`)
  expect(r.stdout).toBe('down')
})
