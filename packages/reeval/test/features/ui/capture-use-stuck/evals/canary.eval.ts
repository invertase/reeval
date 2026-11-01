import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('canary', { environments: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  try {
    await c.capture(server, { name: 'menu', instructions: ['Open the menu'] })
  } catch (error) {
    // Lands fails on the stuck instruction; this expects another wording.
    expect((error as Error).message).toBe('still open')
  }
})
