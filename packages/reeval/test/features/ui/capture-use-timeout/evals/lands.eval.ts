import { evaluate } from 'reeval'
import { ui } from './env.ts'

evaluate('lands', { environment: ui, capture: { timeout: '2s' } }, async (c) => {
  await c.sandbox()
  const server = await c.serve('node server.mjs')
  await c.capture(server, {
    name: 'late',
    instructions: ['never done'],
    use: { fake: [[{ type: 'click', x: 1, y: 1 }]] },
  })
})
