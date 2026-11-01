import { evaluate, expect } from 'reeval'
import { query, state, ui } from './env.ts'

evaluate('lands', { environments: ui }, async (c) => {
  await c.serve('node api.mjs', 9099)
  const server = await c.serve('node page.mjs')
  await c.capture(server, { name: 'loopback', path: query(9099), wait: 'idle' })
  expect((await c.exec(state)).stdout).toBe('host,ip,name,refused,v6,ws')
})
