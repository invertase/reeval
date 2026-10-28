import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

// Must fail: c.serve refuses two ports, it doesn't pick one.
evaluate('canary', { environment: ui }, async (c) => {
  try {
    await c.serve('node server.mjs')
  } catch (error) {
    expect((error as Error).message).toBe('picked one')
  }
})
