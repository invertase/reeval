import { evaluate, expect } from 'reeval'
import { left, server, vm } from './env.ts'

// c.serve finds the port the server listens on, and kill() leaves none of it running.
evaluate('lands', { environments: vm }, async (c) => {
  const app = await c.serve(server)
  const answer = (await c.exec(`curl -s http://127.0.0.1:${app.port}/`)).stdout
  await app.kill()
  expect({ answer, left: (await c.exec(left)).stdout.trim() }).toEqual({ answer: 'ok', left: '0' })
})
