import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

// Must fail: the returned port is PORT's server, not the side port that opened first.
evaluate('canary', { environment: ui }, async (c) => {
  const app = await c.serve('node server.mjs')
  const r = await c.exec(`node probe.mjs ${app.port}`)
  expect(r.stdout).toBe('side')
})
