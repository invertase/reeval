import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

// Must fail: c.serve refuses the port the first server holds, it doesn't serve on it.
evaluate('canary', { environment: ui }, async (c) => {
  const dev = await c.serve('node server.mjs dev')
  try {
    await c.serve('node server.mjs preview $PORT', dev.port)
  } catch (error) {
    expect((error as Error).message).toBe('served')
  }
})
