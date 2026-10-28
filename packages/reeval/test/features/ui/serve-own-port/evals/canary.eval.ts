import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

// Must fail: the server on the returned port is the Vite-style one, not one that reads PORT.
evaluate('canary', { environment: ui }, async (c) => {
  const app = await c.serve('node vite.mjs')
  const r = await c.exec(`node probe.mjs ${app.port}`)
  expect(r.stdout).toBe('reads PORT')
})
