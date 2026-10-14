import { evaluate } from 'reeval'
import { ui } from './env.ts'

evaluate('lands', { environment: ui, capture: { timeout: '5s' } }, async (c) => {
  await c.sandbox()
  const server = await c.serve('node server.mjs')
  await c.capture(server, { name: 'busy', wait: 'idle' })
})
