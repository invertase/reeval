import { evaluate, expect } from 'reeval'
import { fakeInstructions } from 'reeval/testing'
import { ui } from './env.ts'

evaluate('canary', { environment: ui, capture: { timeout: '10s' } }, async (c) => {
  const server = await c.serve('node server.mjs')
  await c.capture(server, {
    name: 'after',
    // Off the button.
    instructions: fakeInstructions([[{ type: 'click', x: 10, y: 10, final: true }]]),
  })
  const state = await c.exec(
    `node -e "fetch('http://127.0.0.1:${server.port}/state').then(r=>r.text()).then(t=>process.stdout.write(t))"`,
  )
  expect(state.stdout).toBe('yes')
})
