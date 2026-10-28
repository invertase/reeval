import { evaluate, expect } from 'reeval'
import { query, state, ui } from './env.ts'

evaluate('canary', { environment: ui }, async (c) => {
  await c.serve('node api.mjs', 9099)
  const server = await c.serve('node page.mjs')
  // The page calls and reports to 9098, where nothing listens, so 9099 hears nothing.
  await c.capture(server, { name: 'loopback', path: query(9098), wait: 'idle' })
  expect((await c.exec(state)).stdout).toBe('host,ip,name,refused,v6,ws')
})
