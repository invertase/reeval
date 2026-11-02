import { evaluate, expect } from 'reeval'
import { fakeInstructions } from 'reeval/testing'
import { ui } from './env.ts'

evaluate('canary', { environments: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  await c.capture(server, {
    name: 'after',
    instructions: fakeInstructions([
      [{ type: 'click', x: 100, y: 2930, final: true }],
      { wait: 'idle' },
      // Under the button, on the empty page.
      [{ type: 'click', x: 100, y: 1500 }, { type: 'done' }],
    ]),
  })
  const state = await c.exec(
    `node -e "fetch('http://127.0.0.1:${server.port}/state').then(r=>r.text()).then(t=>process.stdout.write(t))"`,
  )
  expect(state.stdout).toBe('yes')
})
