import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

// Lands signs up; this expects nobody to have.
evaluate('canary', { environment: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  await c.capture(server, {
    name: 'welcome',
    instructions: ['Sign up as ada@example.com with password Test1234!, then submit'],
  })
  const state = await c.exec(
    `node -e "fetch('http://127.0.0.1:${server.port}/state').then(r=>r.text()).then(t=>process.stdout.write(t))"`,
  )
  expect(state.stdout).toBe('nobody')
})
