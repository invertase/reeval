import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('canary', { environments: ui, capture: { timeout: '5s' } }, async (c) => {
  const server = await c.serve('node server.mjs')
  try {
    await c.capture(server, { name: 'busy', wait: 'idle' })
  } catch (error) {
    expect((error as Error).message).toBe('still loading')
  }
})
