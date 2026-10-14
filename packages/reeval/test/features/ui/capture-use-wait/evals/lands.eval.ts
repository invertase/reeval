import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('lands', { environment: ui }, async (c) => {
  await c.sandbox()
  const server = await c.serve('node server.mjs')
  await c.capture(server, {
    name: 'after-idle',
    instructions: ['Click go', { wait: 'idle' }, 'Click the mark'],
    fake: [
      [{ type: 'click', x: 50, y: 35 }, { type: 'done' }],
      [{ type: 'click', x: 230, y: 215 }, { type: 'done' }],
    ],
  })
  const state = await c.exec(
    `node -e "fetch('http://127.0.0.1:${server.port}/state').then(r=>r.text()).then(t=>process.stdout.write(t))"`,
  )
  expect(state.stdout).toBe('yes')
})
