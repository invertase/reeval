import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('canary', { environment: ui, capture: { timeout: '2s' } }, async (c) => {
  await c.sandbox()
  const server = await c.serve('node server.mjs')
  try {
    await c.capture(server, {
      name: 'late',
      instructions: ['never done'],
      use: { fake: [[{ type: 'click', x: 1, y: 1 }]] },
    })
  } catch (error) {
    // Lands fails on the unfinished instruction; this expects another wording.
    expect((error as Error).message).toBe('still loading')
  }
})
