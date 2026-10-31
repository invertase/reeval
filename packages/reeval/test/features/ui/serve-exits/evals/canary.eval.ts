import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

// Must fail: a command that exits never serves.
evaluate('canary', { environments: ui }, async (c) => {
  try {
    await c.serve('node server.mjs')
  } catch (error) {
    expect((error as Error).message).toBe('served')
  }
})
