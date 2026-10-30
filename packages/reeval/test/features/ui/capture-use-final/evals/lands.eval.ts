import { evaluate, expect } from 'reeval'
import { fakeInstructions } from 'reeval/testing'
import { ui } from './env.ts'

// No `done`: the click marked final ends the instruction, or the capture times out.
evaluate('lands', { environment: ui, capture: { timeout: '10s' } }, async (c) => {
  const server = await c.serve('node server.mjs')
  await c.capture(server, {
    name: 'after',
    instructions: fakeInstructions([[{ type: 'click', x: 140, y: 120, final: true }]]),
  })
  const state = await c.exec(
    `node -e "fetch('http://127.0.0.1:${server.port}/state').then(r=>r.text()).then(t=>process.stdout.write(t))"`,
  )
  expect(state.stdout).toBe('yes')
})
