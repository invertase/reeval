import { evaluate, expect } from 'reeval'
import { left, server, vm } from './env.ts'

// Must fail: the server is still running before kill().
evaluate('canary', { environments: vm }, async (c) => {
  const app = await c.serve(server)
  expect((await c.exec(left)).stdout.trim()).toBe('0')
  await app.kill()
})
