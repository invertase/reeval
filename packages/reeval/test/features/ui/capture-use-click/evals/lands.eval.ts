import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('lands', { environment: ui }, async (c) => {
  await c.sandbox()
  const server = await c.serve('node server.mjs')
  await c.capture(server, {
    name: 'after',
    instructions: ['Click Go'],
    use: {
      fake: [[{ type: 'click', x: 140, y: 120 }, { type: 'done' }]],
    },
  })
  const state = await c.exec(
    `node -e "fetch('http://127.0.0.1:${server.port}/state').then(r=>r.text()).then(t=>process.stdout.write(t))"`,
  )
  expect(state.stdout).toBe('yes')
})
