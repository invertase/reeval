import { evaluate } from 'reeval'
import { fakeInstructions } from 'reeval/testing'
import { ui } from './env.ts'

evaluate('lands', { environment: ui, capture: { timeout: '10s' } }, async (c) => {
  const server = await c.serve('node server.mjs')
  await c.capture(server, {
    name: 'late',
    instructions: fakeInstructions([[{ type: 'click', x: 1, y: 1 }]]),
  })
})
