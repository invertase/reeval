import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

// A server on PORT gets PORT, though a side port opened first.
evaluate('lands', { environments: ui }, async (c) => {
  const app = await c.serve('node server.mjs')
  const r = await c.exec(`node probe.mjs ${app.port}`)
  expect(r.stdout).toBe('main')
})
