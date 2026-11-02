import { evaluate, expect } from 'reeval'
import { readWhenWritten, ui } from './env.ts'

// Must fail: the server listens on its own port, not port 1.
evaluate('canary', { environments: ui }, async (c) => {
  await c.serve('node server.mjs > served.log')
  const r = await c.exec(readWhenWritten('served.log'))
  expect(r.stdout.trim()).toBe('listening on 1')
})
