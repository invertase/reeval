import { evaluate, expect } from 'reeval'
import { readWhenWritten, ui } from './env.ts'

// The server's output goes where the command redirects it, not to reeval's log.
evaluate('lands', { environment: ui }, async (c) => {
  const server = await c.serve('node server.mjs > served.log')
  const r = await c.exec(readWhenWritten('served.log'))
  expect(r.stdout.trim()).toBe(`listening on ${server.port}`)
})
