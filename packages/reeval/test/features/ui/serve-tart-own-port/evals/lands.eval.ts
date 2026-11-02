import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

// c.serve finds the port the server listens on in the VM, though it isn't PORT.
evaluate('lands', { environments: ui }, async (c) => {
  const app = await c.serve('node own-port.mjs')
  const r = await c.exec(`node probe.mjs ${app.port}`)
  expect(r.stdout).toBe('own port')
})
