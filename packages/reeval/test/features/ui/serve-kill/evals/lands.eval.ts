import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

// kill() stops the server itself: the pid reeval holds is the command, not a shell around it.
evaluate('lands', { environment: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  await c.exec(`node probe.mjs ${server.port} up`)
  await server.kill()
  const r = await c.exec(`node probe.mjs ${server.port} down`)
  expect(r.stdout).toBe('down')
})
