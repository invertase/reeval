import { evaluate, expect } from 'reeval'
import { fakeInstructions } from 'reeval/testing'
import { ui } from './env.ts'

evaluate('lands', { environments: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  await c.capture(server, {
    name: 'after-idle',
    instructions: fakeInstructions([
      [{ type: 'click', x: 50, y: 35 }, { type: 'done' }],
      { wait: 'idle' },
      [{ type: 'click', x: 230, y: 215 }, { type: 'done' }],
    ]),
  })
  const state = await c.exec(
    `node -e "fetch('http://127.0.0.1:${server.port}/state').then(r=>r.text()).then(t=>process.stdout.write(t))"`,
  )
  expect(state.stdout).toBe('yes')
})
