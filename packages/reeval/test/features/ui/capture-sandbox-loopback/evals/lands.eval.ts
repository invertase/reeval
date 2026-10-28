import { evaluate, expect } from 'reeval'
import { state, ui } from './env.ts'

evaluate('lands', { environment: ui }, async (c) => {
  await c.serve('node api.mjs', 9099)
  const server = await c.serve('node page.mjs')
  await c.capture(server, { name: 'loopback', path: '/?port=9099', wait: 'idle' })
  expect((await c.exec(state)).stdout).toBe('ip,name')
})
