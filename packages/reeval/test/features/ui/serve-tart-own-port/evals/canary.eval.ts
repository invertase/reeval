import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

// Must fail: the server on the returned port is the one that ignores PORT.
evaluate('canary', { environments: ui }, async (c) => {
  const app = await c.serve('node own-port.mjs')
  const r = await c.exec(`node probe.mjs ${app.port}`)
  expect(r.stdout).toBe('reads PORT')
})
